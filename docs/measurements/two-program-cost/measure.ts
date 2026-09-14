// === What a second TypeScript program costs the tsserver plugin ===
//
// The plugin decision in `docs/design.md` §1 turns on one number: a TypeShade file must be
// type-checked by a program built with `lib: []` and the ambient `SHADE_DTS`, while tsserver's
// own project has the standard library, so the plugin runs a `TypeshadeLanguageService` of its
// own beside the project's. This script measures what that second program costs, on a project
// shaped like a real one.
//
// It measures four things:
//
//   1. What tsserver alone reports on a `"use typeshade"` file, which is the reason the second
//      program exists at all.
//   2. Cold cost: building the project program and answering diagnostics for every file, then
//      building the TypeShade program and answering diagnostics for the shader files.
//   3. Warm cost, which is the one a keystroke pays: one edit to a shader file, then
//      diagnostics for it, in each program.
//   4. What the second program retains, as the live heap before and after it is built, each
//      reading taken after a forced collection, in a process that did nothing else.
//
// Run it with `bun`, because the compiler's `package.json` `exports` still point at TypeScript
// sources. Point `TYPESHADE_COMPILER` at a checkout of `typeshade/typeshade`; it defaults to
// the `vendor/typeshade` submodule this repository will carry.
//
//   TYPESHADE_COMPILER=/path/to/typeshade bun docs/measurements/two-program-cost/measure.ts
//
// The output of the run this document reports is in `README.md` beside this file.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'

/** How many plain TypeScript files the fixture project holds. A mid-size web application is
 *  in the low hundreds of modules; 150 is inside that range and keeps a run under a minute. */
const HOST_FILE_COUNT = 150

/** How many edits the warm measurement averages over. */
const EDIT_COUNT = 20

/** How many times each shader example is copied into the fixture. The second program holds the
 *  shader files and nothing else, so this is the axis its cost actually scales on; raise it to
 *  see that. */
const SHADE_COPIES = Number(process.env.SHADE_COPIES ?? '1')

/** Where the fixture project is written. */
const FIXTURE_DIR = join(process.env.TMPDIR ?? '/tmp', 'typeshade-two-program-fixture')

/** The compiler checkout the TypeShade language service is imported from. */
const COMPILER_DIR = resolve(
  process.env.TYPESHADE_COMPILER ?? join(import.meta.dir, '../../../vendor/typeshade'),
)

/** The shader files copied out of the compiler's own `examples/`, so the measurement runs on
 *  the same sources the compile gate does rather than on shaders written for it. */
const SHADE_EXAMPLES = [
  'hello.shade.ts',
  'hello-uniform.shade.ts',
  'hello-camera.shade.ts',
  'hello-vsin.shade.ts',
  'hello-vsout.shade.ts',
  'compute-reduction-twin.shade.ts',
]

/**
 * One plain TypeScript module of the fixture, shaped like application code rather than like a
 * benchmark: interfaces, a class holding a `Map`, an `async` function, and imports of two
 * siblings, so the program has real edges and the standard library is genuinely in use.
 *
 * @param index - the module's number in the fixture.
 * @returns the module's source text.
 */
function hostModuleSource(index: number): string {
  const left = (index + HOST_FILE_COUNT - 1) % HOST_FILE_COUNT
  const right = (index + 1) % HOST_FILE_COUNT
  return `import { shape${left} } from './mod${left}.js'
import { describe${right}, shape${right} } from './mod${right}.js'

export interface Shape${index} {
  readonly id: string
  readonly values: readonly number[]
  readonly meta: Record<string, string>
}

export class Store${index} {
  private readonly items = new Map<string, Shape${index}>()

  add(item: Shape${index}): this {
    this.items.set(item.id, item)
    return this
  }

  get(id: string): Shape${index} | undefined {
    return this.items.get(id)
  }

  ids(): string[] {
    return [...this.items.keys()].sort()
  }
}

export function shape${index}(id: string): Shape${index} {
  return { id, values: [${index}, ${index + 1}], meta: { source: 'mod${index}' } }
}

export function describe${index}(item: Shape${index}): string {
  return \`\${item.id}: \${item.values.join(', ')}\`
}

export async function load${index}(ids: readonly string[]): Promise<Shape${index}[]> {
  const store = new Store${index}()
  for (const id of ids) store.add(shape${index}(id))
  await Promise.resolve()
  const near = shape${left}('near')
  return store.ids().map((id) => store.get(id) ?? shape${index}(id)).concat([
    { ...near, meta: { ...near.meta, note: describe${right}(shape${right}('r')) } },
  ])
}
`
}

/** Writes the fixture project and returns the absolute paths of its two kinds of file. */
function writeFixture(): { hostFiles: string[]; shadeFiles: string[] } {
  rmSync(FIXTURE_DIR, { recursive: true, force: true })
  mkdirSync(join(FIXTURE_DIR, 'src'), { recursive: true })

  const hostFiles: string[] = []
  for (let i = 0; i < HOST_FILE_COUNT; i++) {
    const file = join(FIXTURE_DIR, 'src', `mod${i}.ts`)
    writeFileSync(file, hostModuleSource(i))
    hostFiles.push(file)
  }

  const shadeFiles: string[] = []
  for (let copy = 0; copy < SHADE_COPIES; copy++) {
    for (const name of SHADE_EXAMPLES) {
      const text = readFileSync(join(COMPILER_DIR, 'examples', name), 'utf8')
      const file = join(
        FIXTURE_DIR,
        'src',
        copy === 0 ? name : name.replace('.shade.ts', `-${copy}.shade.ts`),
      )
      writeFileSync(file, text)
      shadeFiles.push(file)
    }
  }

  writeFileSync(
    join(FIXTURE_DIR, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          lib: ['ES2022', 'DOM'],
          strict: true,
          noEmit: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
  )
  return { hostFiles, shadeFiles }
}

/** The compiler options the fixture's own `tsconfig.json` declares, which is what tsserver
 *  would build the project with. */
function projectOptions(): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    strict: true,
    noEmit: true,
  }
}

/**
 * A `ts.LanguageService` over the fixture on disk, standing in for the one tsserver builds for
 * the project: the same compiler options, the real standard library, and file texts held in
 * memory so an edit can be applied without touching the disk.
 *
 * @param files - every file in the project.
 * @returns the service, and a function that applies an edit to one file.
 */
function projectService(files: readonly string[]): {
  service: ts.LanguageService
  edit: (file: string, text: string) => void
} {
  const texts = new Map<string, string>()
  const versions = new Map<string, number>()
  for (const file of files) {
    texts.set(file, readFileSync(file, 'utf8'))
    versions.set(file, 1)
  }

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...texts.keys()],
    getScriptVersion: (file) => String(versions.get(file) ?? 0),
    getScriptSnapshot: (file) => {
      const text = texts.get(file) ?? ts.sys.readFile(file)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
    getCurrentDirectory: () => FIXTURE_DIR,
    getCompilationSettings: projectOptions,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  }

  return {
    service: ts.createLanguageService(host, ts.createDocumentRegistry()),
    edit: (file, text) => {
      texts.set(file, text)
      versions.set(file, (versions.get(file) ?? 1) + 1)
    },
  }
}

/** Milliseconds a function took, to one decimal place. */
function timed<T>(fn: () => T): { ms: number; value: T } {
  const start = performance.now()
  const value = fn()
  return { ms: Math.round((performance.now() - start) * 10) / 10, value }
}

/** Live heap in megabytes, after a full collection, to one decimal place.
 *
 *  Heap rather than resident set size: RSS is not monotone, and a first run of this script
 *  reported the process holding LESS RSS after the second program was built than before it
 *  (294.2 MB then 263.8 MB), which says something about when the allocator returns pages and
 *  nothing about what the second program retains. A forced collection before each reading
 *  makes the two comparable. `Bun.gc` is the collector this runs under; `global.gc` is node's,
 *  under `--expose-gc`; with neither, the reading is of an uncollected heap and the script
 *  says so. */
function heapMb(): number {
  const bun = (globalThis as { Bun?: { gc: (force: boolean) => void } }).Bun
  const node = (globalThis as { gc?: () => void }).gc
  if (bun) bun.gc(true)
  else if (node) node()
  else console.log('            (no collector exposed: heap readings include garbage)')
  return Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10
}

/** One measured run: what the mode did, and what it cost. */
interface Report {
  readonly mode: string
  readonly coldMs: number
  readonly warmMs: number
  readonly heapMb: number
  readonly notes: readonly string[]
}

/** Prints at most eight of the per-file notes, so a run with many copies stays readable. */
function sample(notes: readonly string[]): string[] {
  return notes.length <= 8 ? [...notes] : [...notes.slice(0, 8), `... ${notes.length - 8} more`]
}

/** Builds the project program and answers diagnostics for every file, then edits one shader
 *  file `EDIT_COUNT` times and re-answers for it. This is what the editor pays with no plugin
 *  loaded, and the diagnostics it reports on the shader files are the false positives the
 *  plugin exists to replace. */
function measureProject(): Report {
  const { hostFiles, shadeFiles } = writeFixture()
  const files = [...hostFiles, ...shadeFiles]
  const { service, edit } = projectService(files)

  const cold = timed(() => {
    let count = 0
    for (const file of files) {
      count += service.getSemanticDiagnostics(file).length
      count += service.getSyntacticDiagnostics(file).length
    }
    return count
  })

  const notes: string[] = []
  for (const file of shadeFiles) {
    const semantic = service.getSemanticDiagnostics(file)
    const codes = [...new Set(semantic.map((d) => `TS${d.code}`))].sort()
    notes.push(`${file.split('/').pop()}: ${semantic.length} semantic (${codes.join(' ') || '-'})`)
  }

  const target = shadeFiles[0]
  const original = readFileSync(target, 'utf8')
  const warm = timed(() => {
    for (let i = 0; i < EDIT_COUNT; i++) {
      edit(target, `${original}\n// edit ${i}\n`)
      service.getSemanticDiagnostics(target)
      service.getSyntacticDiagnostics(target)
    }
  })

  return {
    mode: 'project program only (no plugin)',
    coldMs: cold.ms,
    warmMs: Math.round((warm.ms / EDIT_COUNT) * 10) / 10,
    heapMb: heapMb(),
    notes: [`${cold.value} diagnostics over ${files.length} files`, ...sample(notes)],
  }
}

/** Builds the project program exactly as `measureProject` does, then adds the second program
 *  the plugin runs: a `TypeshadeLanguageService` holding the shader files only. The cold number
 *  is the second program's own build and first diagnostics; the warm number is one edit to a
 *  shader file answered by the TypeShade service. */
async function measurePlugin(): Promise<Report> {
  const { hostFiles, shadeFiles } = writeFixture()
  const files = [...hostFiles, ...shadeFiles]
  const { service } = projectService(files)

  // The plugin only ever runs in a loaded project, so the project program is built first and
  // its cost is not attributed to the second one.
  for (const file of files) {
    service.getSemanticDiagnostics(file)
    service.getSyntacticDiagnostics(file)
  }
  const projectHeap = heapMb()

  // Imported by path rather than by package specifier: this script runs before the repository
  // carries the submodule, and the shape it needs is four methods wide, so a local structural
  // type is cheaper than making the package resolvable from here.
  const { createTypeshadeLanguageService } = (await import(
    join(COMPILER_DIR, 'src/language-service/index.ts')
  )) as {
    createTypeshadeLanguageService: (host?: {
      readDocument?: (uri: string) => string | undefined
    }) => {
      openDocument: (uri: string, text: string, version?: number) => void
      updateDocument: (uri: string, text: string, version?: number) => void
      getDiagnostics: (uri: string) => readonly { source: string; code: string | number }[]
    }
  }

  const texts = new Map(shadeFiles.map((file) => [file, readFileSync(file, 'utf8')]))
  const cold = timed(() => {
    const shade = createTypeshadeLanguageService({
      readDocument: (uri) => texts.get(uri),
    })
    let count = 0
    for (const [uri, text] of texts) {
      shade.openDocument(uri, text, 1)
    }
    for (const uri of texts.keys()) count += shade.getDiagnostics(uri).length
    return { shade, count }
  })

  const notes: string[] = []
  for (const uri of texts.keys()) {
    const diagnostics = cold.value.shade.getDiagnostics(uri)
    const byCode = [...new Set(diagnostics.map((d) => `${d.source}:${d.code}`))].sort()
    notes.push(`${uri.split('/').pop()}: ${diagnostics.length} (${byCode.join(' ') || '-'})`)
  }

  const heapAfterCold = heapMb()
  const target = shadeFiles[0]
  const original = texts.get(target) ?? ''
  const warm = timed(() => {
    for (let i = 0; i < EDIT_COUNT; i++) {
      cold.value.shade.updateDocument(target, `${original}\n// edit ${i}\n`, i + 2)
      cold.value.shade.getDiagnostics(target)
    }
  })

  return {
    mode: 'project program plus the TypeShade program',
    coldMs: cold.ms,
    warmMs: Math.round((warm.ms / EDIT_COUNT) * 10) / 10,
    heapMb: heapMb(),
    notes: [
      `heap ${projectHeap} MB with the project program alone, ${heapAfterCold} MB once the`,
      `  TypeShade program was built and had answered for every shader file`,
      `${cold.value.count} diagnostics over ${texts.size} shader files`,
      ...sample(notes),
    ],
  }
}

/** Prints one report as the lines the README quotes. */
function print(report: Report): void {
  console.log(`## ${report.mode}`)
  console.log(`cold        ${report.coldMs} ms`)
  console.log(`warm/edit   ${report.warmMs} ms`)
  console.log(`heap        ${report.heapMb} MB`)
  for (const note of report.notes) console.log(`            ${note}`)
  console.log('')
}

async function main(): Promise<number> {
  const mode = process.argv[2]
  if (mode === 'project') {
    print(measureProject())
    return 0
  }
  if (mode === 'plugin') {
    print(await measurePlugin())
    return 0
  }

  // Default: run each mode in its own process, so the resident-memory numbers are of a
  // process that did one of the two things rather than of one heap holding both.
  console.log(`node ${process.version}, typescript ${ts.version}, bun ${process.versions.bun}`)
  console.log(
    `fixture: ${HOST_FILE_COUNT} .ts files, ${SHADE_EXAMPLES.length * SHADE_COPIES} .shade.ts files`,
  )
  console.log(`compiler: ${COMPILER_DIR}`)
  console.log('')
  for (const child of ['project', 'plugin']) {
    const run = spawnSync(process.execPath, [import.meta.path, child], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    process.stdout.write(run.stdout)
    if (run.status !== 0) return run.status ?? 1
  }
  return 0
}

if (import.meta.main) process.exit(await main())
