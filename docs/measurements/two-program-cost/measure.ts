// === What a second TypeScript program costs the tsserver plugin ===
//
// The plugin decision in `docs/design.md` §1 turns on one number: a TypeShade file must be
// type-checked by a program built with `lib: []` and the ambient `SHADE_DTS`, while tsserver's
// own project has the standard library, so the plugin runs a `TypeshadeLanguageService` of its
// own beside the project's. This script measures what that second program costs.
//
// WHAT THE FIRST VERSION OF THIS SCRIPT GOT WRONG, since the method is the finding. It ran
// both halves in one process, so the heap figure was the difference of two whole-process
// readings taken while an unrelated 85 MB program sat in the same heap, which measures the
// collector's timing as much as the subject: re-running it three times gave deltas of 5.1,
// 13.1 and 40.3 MB for what it reported as 4.4 MB. It left the compiler's `await import()`
// outside the timed region, so the cold number omitted a module load tsserver pays
// synchronously while a project loads. And it ran under bun, whose `process.version` reports a
// node version string, so the output named a node run that never happened. tsserver runs under
// node.
//
// So this file is only a driver. It writes the fixture, bundles the compiler's
// `./language-service` subpath the way the plugin will ship it, then spawns `harness.mjs` under
// `node --expose-gc`, three times per mode, each in a process that does nothing else, and
// reports a range. The phases are split the way they are paid: requiring the bundle once per
// tsserver process, building the program once per project, answering once per keystroke.
//
// Run the driver with `bun`, because it is TypeScript; nothing it imports comes from the
// compiler, and the measuring itself happens under node. Point `TYPESHADE_COMPILER` at a
// checkout of `typeshade/typeshade`; it defaults to the `vendor/typeshade` submodule.
//
//   bun docs/measurements/two-program-cost/measure.ts
//
// The output of the runs this document reports is in `README.md` beside this file.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

/** How many plain TypeScript files the fixture project holds. A mid-size web application is
 *  in the low hundreds of modules; 150 is inside that range and keeps a run under a minute. */
const HOST_FILE_COUNT = 150;

/** How many times each shader example is copied into the fixture. The second program holds the
 *  shader files and nothing else, so this is the axis its cost actually scales on. */
const SHADE_COPIES = Number(process.env.SHADE_COPIES ?? '1');

/** How many times each mode runs. Three is the least that shows a range rather than a value. */
const RUNS = Number(process.env.RUNS ?? '3');

/** Where the fixture project is written. */
const WORK_DIR = join(process.env.TMPDIR ?? '/tmp', 'typeshade-two-program-fixture');

/** Where the bundle is written: inside the workspace, not beside the fixture in a temporary
 *  directory. The bundle leaves `typescript` external, so it is resolved by node walking up
 *  from the bundle's own path, and from `/tmp` that walk finds nothing. This is the same fact
 *  `README.md` records about the vendored compiler checkout, one level further out. */
const BUNDLE_DIR = join(resolve(import.meta.dir, '../../..'), 'node_modules/.cache/typeshade');

/** The compiler checkout the TypeShade language service is bundled from. */
const COMPILER_DIR = resolve(
  process.env.TYPESHADE_COMPILER ?? join(import.meta.dir, '../../../vendor/typeshade'),
);

/** The shader files copied out of the compiler's own `examples/`, so the measurement runs on
 *  the same sources the compile gate does rather than on shaders written for it. */
const SHADE_EXAMPLES = [
  'hello.shade.ts',
  'hello-uniform.shade.ts',
  'hello-camera.shade.ts',
  'hello-vsin.shade.ts',
  'hello-vsout.shade.ts',
  'compute-reduction-twin.shade.ts',
];

/**
 * One plain TypeScript module of the fixture, shaped like application code rather than like a
 * benchmark: interfaces, a class holding a `Map`, an `async` function, and imports of two
 * siblings, so the program has real edges and the standard library is genuinely in use.
 *
 * @param index - the module's number in the fixture.
 * @returns the module's source text.
 */
function hostModuleSource(index: number): string {
  const left = (index + HOST_FILE_COUNT - 1) % HOST_FILE_COUNT;
  const right = (index + 1) % HOST_FILE_COUNT;
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
`;
}

/** Writes the fixture project, and returns how many files of each kind it holds. */
function writeFixture(): { hosts: number; shaders: number } {
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(join(WORK_DIR, 'src'), { recursive: true });

  for (let i = 0; i < HOST_FILE_COUNT; i++) {
    writeFileSync(join(WORK_DIR, 'src', `mod${i}.ts`), hostModuleSource(i));
  }

  let shaders = 0;
  for (let copy = 0; copy < SHADE_COPIES; copy++) {
    for (const name of SHADE_EXAMPLES) {
      const text = readFileSync(join(COMPILER_DIR, 'examples', name), 'utf8');
      const file = copy === 0 ? name : name.replace('.shade.ts', `-${copy}.shade.ts`);
      writeFileSync(join(WORK_DIR, 'src', file), text);
      shaders += 1;
    }
  }

  writeFileSync(
    join(WORK_DIR, 'tsconfig.json'),
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
  );
  return { hosts: HOST_FILE_COUNT, shaders };
}

/**
 * Bundles the compiler's `./language-service` subpath the way `docs/design.md` §2 says the
 * plugin ships it: one CommonJS file for node, with `typescript` external, because tsserver
 * hands the plugin its own instance.
 *
 * @returns the bundle's path and its size in kilobytes.
 */
async function bundleLanguageService(): Promise<{ path: string; kb: number }> {
  mkdirSync(BUNDLE_DIR, { recursive: true });
  const out = join(BUNDLE_DIR, 'language-service.cjs');
  await build({
    entryPoints: [join(COMPILER_DIR, 'src/language-service/index.ts')],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['typescript'],
    logLevel: 'error',
  });
  return { path: out, kb: Math.round(statSync(out).size / 1024) };
}

/** One harness run's JSON line. The driver only formats it, so the fields stay untyped here
 *  and `harness.mjs` is the one place that decides what a mode reports. */
type Report = Record<string, unknown>;

/** Runs `harness.mjs` under node once, and returns the report it printed. */
function runHarness(mode: 'project' | 'plugin', bundle: string): Report {
  const harness = join(import.meta.dir, 'harness.mjs');
  const run = spawnSync('node', ['--expose-gc', harness, mode, WORK_DIR, bundle], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (run.status !== 0) throw new Error(`harness ${mode} exited ${String(run.status)}`);
  return JSON.parse(run.stdout) as Report;
}

/** One numeric field across the runs: the range, with every sample in parentheses, so a reader
 *  can see the spread rather than trust a midpoint. */
function range(reports: readonly Report[], field: string, unit: string): string {
  const values = reports.map((r) => Number(r[field]));
  const low = Math.min(...values);
  const high = Math.max(...values);
  const suffix = unit === '' ? '' : ` ${unit}`;
  const all = values.join(', ');
  return low === high ? `${low}${suffix} (${all})` : `${low} to ${high}${suffix} (${all})`;
}

async function main(): Promise<number> {
  const fixture = writeFixture();
  const bundle = await bundleLanguageService();

  console.log(`driver: bun ${process.versions.bun ?? '?'}, measuring under node`);
  console.log(`fixture: ${fixture.hosts} .ts files, ${fixture.shaders} .shade.ts files`);
  console.log(`compiler: ${COMPILER_DIR}`);
  console.log(`bundle: ${bundle.kb} KB (esbuild, cjs, node20, typescript external)`);
  console.log(`runs: ${RUNS} per mode, each in its own process`);
  console.log('');

  const project: Report[] = [];
  const plugin: Report[] = [];
  for (let i = 0; i < RUNS; i++) {
    project.push(runHarness('project', bundle.path));
    plugin.push(runHarness('plugin', bundle.path));
  }

  console.log(`## the editor today, no plugin (${String(project[0].runtime)})`);
  console.log(`cold, whole project        ${range(project, 'coldMs', 'ms')}`);
  console.log(`warm, one shader edit      ${range(project, 'warmMs', 'ms')}`);
  console.log(`heap for the project       ${range(project, 'heapMb', 'MB')}`);
  console.log(`false errors on shaders    ${range(project, 'falseOnShaders', '')}`);
  const perFile = project[0].perFile as Record<string, { count: number; codes: string[] }>;
  for (const [name, entry] of Object.entries(perFile).slice(0, 8)) {
    console.log(`                           ${name}: ${entry.count} (${entry.codes.join(' ')})`);
  }
  console.log('');

  console.log(`## what the plugin adds (${String(plugin[0].runtime)})`);
  console.log(`require the bundle         ${range(plugin, 'requireMs', 'ms')}`);
  console.log(`  heap it retains          ${range(plugin, 'requireHeapMb', 'MB')}`);
  console.log(`build and answer for all   ${range(plugin, 'buildMs', 'ms')}`);
  console.log(`  heap it retains          ${range(plugin, 'buildHeapMb', 'MB')}`);
  console.log(`retained, both phases      ${range(plugin, 'retainedHeapMb', 'MB')}`);
  console.log(`warm, one shader edit      ${range(plugin, 'warmMs', 'ms')}`);
  console.log(`diagnostics on shaders     ${range(plugin, 'diagnostics', '')}`);
  return 0;
}

if (import.meta.main) process.exit(await main());
