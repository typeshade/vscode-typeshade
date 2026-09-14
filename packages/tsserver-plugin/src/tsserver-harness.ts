// === Driving a real tsserver over stdio ===
//
// Test-only. `docs/design.md` §6 tests the plugin against the real server rather than against a
// hand-built `ts.LanguageService`, because the part most likely to break is the loading and
// decoration contract, and only the real server exercises that: the plugin is `require`d by
// name from a probe location, its `create` is called per project, and its answers come back
// through the same events an editor reads.
//
// The protocol is newline-delimited JSON in and `Content-Length`-framed JSON out, and its
// positions are ONE-based line and offset, unlike every other coordinate in this repository.
// `at()` is the only place that conversion happens.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The repository root, which is also the plugin probe location: npm workspaces links
 *  `node_modules/@typeshade/tsserver-plugin` to `packages/tsserver-plugin`, which is the layout
 *  tsserver resolves a plugin name against. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** One message read off the server's stdout. */
export interface ServerMessage {
  readonly type: string
  readonly seq?: number
  readonly request_seq?: number
  readonly command?: string
  readonly event?: string
  readonly success?: boolean
  readonly body?: unknown
}

/** A diagnostic as the protocol reports it. */
export interface ProtocolDiagnostic {
  readonly text: string
  readonly code?: number
  readonly category: string
  readonly source?: string
  readonly start: { line: number; offset: number }
}

/** The three diagnostic kinds `geterr` answers with, for one file. */
export interface FileDiagnostics {
  readonly semantic: readonly ProtocolDiagnostic[]
  readonly syntactic: readonly ProtocolDiagnostic[]
  readonly suggestion: readonly ProtocolDiagnostic[]
}

/** How a server is started. */
export interface HarnessOptions {
  /** The fixture directory to serve. */
  readonly dir: string
  /** Load the plugin. False starts a bare server, which is how the pass-through equality test
   *  gets something to compare against. */
  readonly plugin?: boolean
}

/**
 * Spawns `tsserver.js` and drives it.
 *
 * @param options - the fixture directory and whether to load the plugin.
 * @returns the handle, which must be stopped.
 */
export function startServer(options: HarnessOptions): Harness {
  return new Harness(options)
}

/** A running server, and the operations a protocol test needs. */
export class Harness {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly messages: ServerMessage[] = []
  private readonly waiters: {
    predicate: (m: ServerMessage) => boolean
    resolve: (m: ServerMessage) => void
    timer: NodeJS.Timeout
  }[] = []
  private readonly logFile: string
  private buffer = ''
  private seq = 0

  constructor(private readonly options: HarnessOptions) {
    this.logFile = join(options.dir, 'tsserver.log')
    const args = [
      join(ROOT, 'node_modules/typescript/lib/tsserver.js'),
      '--logVerbosity',
      'verbose',
      '--logFile',
      this.logFile,
    ]
    if (options.plugin !== false) {
      args.push('--globalPlugins', '@typeshade/tsserver-plugin', '--pluginProbeLocations', ROOT)
    }
    this.child = spawn('node', args, { cwd: options.dir, stdio: 'pipe' })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.read(chunk))
  }

  /** The file's absolute path inside the fixture. */
  file(name: string): string {
    return join(this.options.dir, name)
  }

  /** Opens a file with the text on disk, or with `text` when the test supplies one. */
  open(name: string, text?: string): void {
    const file = this.file(name)
    this.send('open', {
      file,
      fileContent: text ?? readFileSync(file, 'utf8'),
      scriptKindName: 'TS',
    })
  }

  /** Replaces an open file's text, the way an edit followed by a save does. Close and re-open
   *  rather than a text change, because the point is always the new whole text and the
   *  protocol's incremental form is coordinates this test would only have to convert twice. */
  reopen(name: string, text: string): void {
    this.send('close', { file: this.file(name) })
    this.send('open', { file: this.file(name), fileContent: text, scriptKindName: 'TS' })
  }

  /** Asks for the three diagnostic kinds and waits for all of them.
   *
   *  @param name - the file, relative to the fixture.
   *  @returns the three lists.
   */
  async diagnostics(name: string): Promise<FileDiagnostics> {
    const file = this.file(name)
    const kinds = ['semanticDiag', 'syntaxDiag', 'suggestionDiag'] as const
    const before = this.messages.length
    this.send('geterr', { files: [file], delay: 0 })
    const events = await Promise.all(
      kinds.map((kind) =>
        this.waitFor(
          (m, index) =>
            index >= before &&
            m.event === kind &&
            (m.body as { file?: string } | undefined)?.file === file,
          kind,
        ),
      ),
    )
    const [semantic, syntactic, suggestion] = events.map(
      (event) => (event.body as { diagnostics?: ProtocolDiagnostic[] }).diagnostics ?? [],
    )
    return { semantic, syntactic, suggestion }
  }

  /** Sends a request and waits for its response.
   *
   *  @param command - the protocol command.
   *  @param args - its arguments.
   *  @returns the response body.
   */
  async request<T>(command: string, args: Record<string, unknown>): Promise<T | undefined> {
    const seq = this.send(command, args)
    const response = await this.waitFor(
      (m) => m.type === 'response' && m.request_seq === seq,
      command,
    )
    return response.body as T | undefined
  }

  /** A one-based protocol position for a zero-based line and character. */
  static at(line: number, character: number): { line: number; offset: number } {
    return { line: line + 1, offset: character + 1 }
  }

  /** Every event the server has sent, for a test that compares whole sessions. */
  events(): readonly ServerMessage[] {
    return this.messages.filter((m) => m.type === 'event')
  }

  /** The server's log, which is where a plugin exception would appear. */
  log(): string {
    return existsSync(this.logFile) ? readFileSync(this.logFile, 'utf8') : ''
  }

  /** Stops the server. */
  stop(): void {
    for (const waiter of this.waiters) clearTimeout(waiter.timer)
    this.waiters.length = 0
    this.child.kill()
  }

  /** Writes one request and returns its sequence number. */
  private send(command: string, args: Record<string, unknown>): number {
    this.seq += 1
    this.child.stdin.write(
      `${JSON.stringify({ seq: this.seq, type: 'request', command, arguments: args })}\n`,
    )
    return this.seq
  }

  /** Frames the server's stdout and hands each message to whoever is waiting. */
  private read(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const header = /Content-Length: (\d+)\r\n\r\n/.exec(this.buffer)
      if (!header) return
      const start = header.index + header[0].length
      const length = Number(header[1])
      if (this.buffer.length < start + length) return
      const message = JSON.parse(this.buffer.slice(start, start + length)) as ServerMessage
      this.buffer = this.buffer.slice(start + length)
      this.messages.push(message)
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i].predicate(message)) {
          const waiter = this.waiters.splice(i, 1)[0]
          clearTimeout(waiter.timer)
          waiter.resolve(message)
        }
      }
    }
  }

  /** Resolves with the first message matching `predicate`, including ones already read. */
  private waitFor(
    predicate: (message: ServerMessage, index: number) => boolean,
    label: string,
  ): Promise<ServerMessage> {
    const existingIndex = this.messages.findIndex((m, i) => predicate(m, i))
    if (existingIndex !== -1) return Promise.resolve(this.messages[existingIndex])
    return new Promise((resolveWaiter, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 20_000)
      this.waiters.push({
        predicate: (m) => predicate(m, this.messages.length - 1),
        resolve: resolveWaiter,
        timer,
      })
    })
  }
}

/**
 * Writes a fixture project into a fresh temporary directory.
 *
 * @param files - file name to text. A name of `tsconfig.json` is written as given; omit it
 *   entirely for the inferred-project case, which is how most people first open a shader.
 * @returns the directory, which the caller removes.
 */
export function writeFixture(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'typeshade-plugin-'))
  for (const [name, text] of Object.entries(files)) {
    const file = join(dir, name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  return dir
}

/** Removes a fixture directory. */
export function removeFixture(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}
