// === Does a real tsserver load the plugin, and can a test drive it over stdio? ===
//
// `docs/design.md` §6 chooses to test the plugin against a real `tsserver.js` rather than
// against a hand-built `ts.LanguageService`, because the thing most likely to break is the
// loading and decoration contract, and only the real server exercises that. Two questions had
// to be answered before the design could rest on it:
//
//   1. Does tsserver find and run a plugin passed with `--globalPlugins`, resolved from a
//      `--pluginProbeLocations` directory, when the project's own tsconfig does not name it?
//   2. Can a test drive the protocol over stdio well enough to read diagnostics back, in this
//      sandbox and in CI, with no editor present?
//
// This script answers both, on the pass-through plugin. It builds nothing: run
// `npm run build` first so `packages/tsserver-plugin/dist/index.js` exists.
//
//   bun docs/measurements/tsserver-plugin-load/probe.ts
//
// The output of the run the design document reports is in `README.md` beside this file.

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** The repository root, which is also the plugin probe location: npm workspaces already links
 *  `node_modules/@typeshade/tsserver-plugin` to `packages/tsserver-plugin`, which is exactly
 *  the layout tsserver resolves a plugin name against. */
const ROOT = resolve(import.meta.dir, '../../..')

/** Where the fixture project and the server log are written. */
const WORK_DIR = join(process.env.TMPDIR ?? '/tmp', 'typeshade-tsserver-probe')

/** A `"use typeshade"` file, and a plain TypeScript file, so the run shows what the server
 *  says about each. */
const FIXTURES: Readonly<Record<string, string>> = {
  'shader.shade.ts': `"use typeshade"

class Color {
  @location(0) color: vec4
}

@fragment
export function fs(): Color {
  return { color: vec4(1., 0., 0., 1.) }
}
`,
  'host.ts': `export const clearColor: readonly number[] = [1, 0, 0, 1]
`,
}

/** One response or event read off the server's stdout. */
interface ServerMessage {
  readonly type: string
  readonly command?: string
  readonly event?: string
  readonly body?: unknown
}

/** A tsserver process, and the two operations a protocol test needs. */
interface Server {
  send: (command: string, args: unknown) => void
  waitFor: (predicate: (message: ServerMessage) => boolean, label: string) => Promise<ServerMessage>
  messages: readonly ServerMessage[]
  stop: () => void
}

/**
 * Spawns `tsserver.js` and frames its stdout. The protocol is newline-delimited JSON in and
 * `Content-Length`-framed JSON out, so the reader keeps a buffer rather than reading lines.
 *
 * @param args - extra command-line arguments, which is where the plugin is named.
 * @returns the handle a probe drives.
 */
function startServer(args: readonly string[]): Server {
  const tsserver = join(ROOT, 'node_modules/typescript/lib/tsserver.js')
  const child = spawn('node', [tsserver, ...args], { cwd: WORK_DIR, stdio: 'pipe' })
  const messages: ServerMessage[] = []
  const waiters: {
    predicate: (m: ServerMessage) => boolean
    resolve: (m: ServerMessage) => void
  }[] = []
  let buffer = ''
  let seq = 0

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const header = /Content-Length: (\d+)\r\n\r\n/.exec(buffer)
      if (!header) return
      const start = header.index + header[0].length
      const length = Number(header[1])
      if (buffer.length < start + length) return
      const message = JSON.parse(buffer.slice(start, start + length)) as ServerMessage
      buffer = buffer.slice(start + length)
      messages.push(message)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(message)) waiters.splice(i, 1)[0].resolve(message)
      }
    }
  })

  return {
    messages,
    send: (command, args) => {
      seq += 1
      child.stdin.write(`${JSON.stringify({ seq, type: 'request', command, arguments: args })}\n`)
    },
    waitFor: (predicate, label) =>
      new Promise((resolveWaiter, reject) => {
        const existing = messages.find(predicate)
        if (existing) return resolveWaiter(existing)
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 20_000)
        waiters.push({
          predicate,
          resolve: (m) => {
            clearTimeout(timer)
            resolveWaiter(m)
          },
        })
      }),
    stop: () => child.kill(),
  }
}

async function main(): Promise<number> {
  rmSync(WORK_DIR, { recursive: true, force: true })
  mkdirSync(WORK_DIR, { recursive: true })
  for (const [name, text] of Object.entries(FIXTURES)) {
    writeFileSync(join(WORK_DIR, name), text)
  }
  writeFileSync(
    join(WORK_DIR, 'tsconfig.json'),
    JSON.stringify(
      { compilerOptions: { target: 'ES2022', strict: true, noEmit: true }, include: ['*.ts'] },
      null,
      2,
    ),
  )

  // Without `--allowLocalPluginLoads` as well as with it: VS Code passes the extension's own
  // directory as a probe location and does not pass that flag, so a test that only works with
  // it would be testing something the editor never does.
  const allowLocal = process.argv.includes('--allow-local')
  const logFile = join(WORK_DIR, 'tsserver.log')
  const server = startServer([
    '--globalPlugins',
    '@typeshade/tsserver-plugin',
    '--pluginProbeLocations',
    ROOT,
    ...(allowLocal ? ['--allowLocalPluginLoads'] : []),
    '--logVerbosity',
    'verbose',
    '--logFile',
    logFile,
  ])

  const shader = join(WORK_DIR, 'shader.shade.ts')
  const host = join(WORK_DIR, 'host.ts')
  server.send('open', { file: shader, fileContent: FIXTURES['shader.shade.ts'] })
  server.send('open', { file: host, fileContent: FIXTURES['host.ts'] })
  server.send('geterr', { files: [shader, host], delay: 0 })
  await server.waitFor(
    (m) => m.event === 'requestCompleted' || m.event === 'semanticDiag',
    'diagnostics',
  )
  // `geterr` answers with one event per kind per file and no single completion marker for the
  // batch, so the probe waits out the remaining events rather than racing them.
  await new Promise((r) => setTimeout(r, 2000))

  server.send('quickinfo', { file: shader, line: 9, offset: 19 })
  const quickInfo = await server.waitFor((m) => m.command === 'quickinfo', 'quickinfo')
  server.stop()

  const log = readFileSync(logFile, 'utf8')
  const loaded = log.includes('[typeshade] plugin loaded')
  const enabled = log.includes('Enabling plugin @typeshade/tsserver-plugin')

  console.log(`tsserver     ${join(ROOT, 'node_modules/typescript/lib/tsserver.js')}`)
  console.log(
    `flags        --globalPlugins --pluginProbeLocations${allowLocal ? ' --allowLocalPluginLoads' : ''}`,
  )
  console.log(`plugin       enabled=${enabled} create-ran=${loaded}`)
  for (const line of log.split('\n').filter((l) => l.includes('@typeshade/tsserver-plugin'))) {
    console.log(`             ${line.replace(/^Info \d+\s+\[[^\]]+\]\s*/, '')}`)
  }
  console.log(
    `             ${log.split('\n').find((l) => l.includes('[typeshade] plugin loaded'))}`,
  )

  for (const file of [shader, host]) {
    for (const kind of ['semanticDiag', 'syntaxDiag', 'suggestionDiag']) {
      const event = server.messages.find(
        (m) => m.event === kind && (m.body as { file?: string } | undefined)?.file === file,
      )
      const diagnostics = (event?.body as { diagnostics?: { code?: number }[] })?.diagnostics ?? []
      const codes = [...new Set(diagnostics.map((d) => `TS${d.code}`))].sort().join(' ')
      console.log(
        `${(file.split('/').pop() ?? '').padEnd(18)} ${kind.padEnd(15)} ${diagnostics.length} ${codes}`,
      )
    }
  }
  const displayString = (quickInfo.body as { displayString?: string } | undefined)?.displayString
  console.log(`quickinfo    vec4 call site reads as ${JSON.stringify(displayString ?? null)}`)

  return loaded && enabled ? 0 : 1
}

if (import.meta.main) process.exit(await main())
