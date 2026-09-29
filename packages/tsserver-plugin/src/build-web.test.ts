import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BROKEN,
  CLEAN,
  DOCUMENTED,
  LIB,
  MAIN,
  PACKAGE_JSON,
  PACKAGE_SHADER,
  SYNTAX,
  USES_PACKAGE,
} from './fixtures.js';
import { DRIVER } from './web-driver.js';

const WEB_BUNDLE = fileURLToPath(new URL('../dist/index.web.js', import.meta.url));
const DESKTOP_BUNDLE = fileURLToPath(new URL('../dist/index.js', import.meta.url));
/** Any file inside this repository resolves the workspace's own `typescript`, which is the
 *  stand-in for the instance a real host hands the plugin. */
const TS_FROM = fileURLToPath(import.meta.url);

/** The bytes of a bundle whose size a browser worker pays for on every start. The measured size
 *  is about 4.4 MiB; this is the ceiling, not the target. */
const SIZE_LIMIT = 8 * 1024 * 1024;

interface Case {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly serverOnly?: Readonly<Record<string, string>>;
  readonly diagnosticsOf: readonly string[];
  readonly probes?: readonly { file: string; find: string; delta: number }[];
}

interface Diagnostic {
  code: number;
  source?: string;
  text: string;
}

interface CaseResult {
  name: string;
  createThrew?: string;
  decorationFailed?: boolean;
  diagnostics: Record<string, Diagnostic[] | { threw: string }>;
  hover: ({ display: string; documentation: string } | null | { threw: string })[];
  definition: unknown[];
}

interface DriverOutput {
  globalsLeft: string[];
  results: CaseResult[];
}

/** Runs `cases` against one bundle in a child node process and returns what it printed.
 *  The web bundle is copied to a `.mjs` first: node reads a `.js` with no `type` as CommonJS. */
function drive(options: {
  kind: 'web' | 'desktop';
  mode: 'semantic' | 'partial';
  stripGlobals: boolean;
  nodeLikeShim?: boolean;
  cases: readonly Case[];
}): DriverOutput {
  const dir = mkdtempSync(join(tmpdir(), 'typeshade-web-'));
  try {
    const bundle = join(dir, options.kind === 'web' ? 'plugin.mjs' : 'plugin.cjs');
    cpSync(options.kind === 'web' ? WEB_BUNDLE : DESKTOP_BUNDLE, bundle);
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({ ...options, bundle, tsFrom: TS_FROM }));
    const driver = join(dir, 'driver.mjs');
    writeFileSync(driver, DRIVER);
    let stdout: string;
    try {
      stdout = execFileSync(process.execPath, [driver, config], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      // The child's own stderr is what says which global or module it reached for.
      const stderr = (error as { stderr?: string }).stderr ?? '';
      throw new Error(`the ${options.kind} bundle failed in the child process:\n${stderr}`, {
        cause: error,
      });
    }
    return JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as DriverOutput;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function codesOf(result: CaseResult, file: string): number[] {
  const found = result.diagnostics[file];
  if (found === undefined || !Array.isArray(found)) {
    throw new Error(`no diagnostics for ${file}: ${JSON.stringify(found)}`);
  }
  return found.map((d) => d.code);
}

/** A result without its log lines: the two bundles log the same text, but the comparison is about
 *  what an editor would show. */
function withoutLogs(result: CaseResult & { logs?: string[] }): Omit<CaseResult, 'logs'> {
  const { logs, ...rest } = result;
  void logs;
  return rest;
}

const PLAIN_TS = `const n: number = 'not a number'\nexport { n }\n`;

describe('the web bundle, as a file', () => {
  it('exists, is an ES module with a default export, and stays under the size ceiling', () => {
    // `npm run build` must have run: `npm run check` does it first.
    expect(existsSync(WEB_BUNDLE), `${WEB_BUNDLE} is missing; run npm run build`).toBe(true);
    const text = readFileSync(WEB_BUNDLE, 'utf8');
    // Minified, so the export is `export{X as default}`; unminified it would be `export default`.
    expect(text).toMatch(/export\s*\{[^}]*\bas default\b[^}]*\}|export default/);
    // The string "module.exports" appears inside TypeScript's own emitter text, so what is
    // ruled out is the assignment a CommonJS footer would add.
    expect(text).not.toMatch(/(^|[;\n])\s*module\.exports\s*=/);
    expect(statSync(WEB_BUNDLE).size).toBeLessThan(SIZE_LIMIT);
  });

  it('requires nothing from node', () => {
    const text = readFileSync(WEB_BUNDLE, 'utf8');
    expect(text).not.toMatch(/require\(["']node:/);
    expect(text).not.toMatch(/from\s*["']node:/);
    expect(text).not.toMatch(/import\(["']node:/);
  });

  it('leaves the desktop bundle a CommonJS module whose export is the factory', () => {
    // The two bundles come from one source; the desktop one must not have picked up any of the
    // web one's shape.
    const text = readFileSync(DESKTOP_BUNDLE, 'utf8');
    expect(text).toMatch(/module\.exports = module\.exports\.init\s*$/);
    expect(text).not.toMatch(/export\s*\{[^}]*\bas default\b/);
  });
});

describe('the web bundle, loaded with none of node around it', () => {
  const cases: Case[] = [
    {
      name: 'broken shader',
      files: { '/p/a.shade.ts': BROKEN, '/p/b.ts': PLAIN_TS },
      diagnosticsOf: ['/p/a.shade.ts', '/p/b.ts'],
    },
    {
      name: 'hover on a documented function',
      files: { '/p/a.shade.ts': DOCUMENTED },
      diagnosticsOf: ['/p/a.shade.ts'],
      probes: [{ file: '/p/a.shade.ts', find: 'tint(1.)', delta: 1 }],
    },
  ];

  it('loads, creates the plugin over a real language service, and answers, in a normal server', () => {
    const output = drive({ kind: 'web', mode: 'semantic', stripGlobals: true, cases });
    // The child really had none of them, so the pass below means something.
    expect(output.globalsLeft).toEqual([]);
    const [broken, documented] = output.results;
    expect(broken.createThrew).toBeUndefined();
    expect(broken.decorationFailed).toBe(false);
    expect(codesOf(broken, '/p/a.shade.ts')).toEqual([8004]);
    const shader = broken.diagnostics['/p/a.shade.ts'] as Diagnostic[];
    expect(shader[0].source).toBe('typeshade');
    // A file without the directive goes to TypeScript untouched: the assignment error is its.
    expect(codesOf(broken, '/p/b.ts')).toContain(2322);
    expect(documented.hover[0]).toMatchObject({ display: 'function tint(x: f32): f32' });
  });

  it('still loads where a shim leaves a process with nextTick and a require that fails', () => {
    // This is what holds the build's \`process.browser\` definition in place. With every global
    // deleted the bundled TypeScript never takes its node path whatever the build says, so the
    // test above cannot notice the definition going missing; a \`process.nextTick\` and a
    // \`require\` are exactly the pair that makes TypeScript call itself node-like, and only
    // \`process.browser\` being true keeps it from reading \`os.platform()\` out of nothing.
    const output = drive({
      kind: 'web',
      mode: 'semantic',
      stripGlobals: true,
      nodeLikeShim: true,
      cases,
    });
    const [broken] = output.results;
    expect(broken.createThrew).toBeUndefined();
    expect(codesOf(broken, '/p/a.shade.ts')).toEqual([8004]);
  });

  it('answers in a syntax-only server too (partial semantic, no resolution, no types)', () => {
    const output = drive({ kind: 'web', mode: 'partial', stripGlobals: true, cases });
    expect(output.globalsLeft).toEqual([]);
    const [broken, documented] = output.results;
    expect(broken.createThrew).toBeUndefined();
    expect(broken.decorationFailed).toBe(false);
    expect(codesOf(broken, '/p/a.shade.ts')).toEqual([8004]);
    expect(documented.hover[0]).toMatchObject({ display: 'function tint(x: f32): f32' });
  });
});

describe('the web bundle against the desktop bundle', () => {
  // The same six-plus programs go through both bundles, and every diagnostic, hover and
  // definition must come back identical. What this rules out is the minifier having changed a
  // message, a position, or the stack-frame check `core/diagnostics/loc.ts` makes to tell the
  // compiler's frames from an author's.
  const cases: Case[] = [
    {
      name: 'clean shader',
      files: { '/p/a.shade.ts': CLEAN },
      diagnosticsOf: ['/p/a.shade.ts'],
      probes: [
        { file: '/p/a.shade.ts', find: 'tint(1.', delta: 1 },
        { file: '/p/a.shade.ts', find: 'Color {', delta: 1 },
      ],
    },
    {
      name: 'unknown function (8004)',
      files: { '/p/a.shade.ts': BROKEN },
      diagnosticsOf: ['/p/a.shade.ts'],
      probes: [{ file: '/p/a.shade.ts', find: 'nope', delta: 1 }],
    },
    {
      name: 'syntax error',
      files: { '/p/a.shade.ts': SYNTAX },
      diagnosticsOf: ['/p/a.shade.ts'],
    },
    {
      name: 'a relative import',
      files: { '/p/main.shade.ts': MAIN, '/p/lib.shade.ts': LIB },
      diagnosticsOf: ['/p/main.shade.ts', '/p/lib.shade.ts'],
      probes: [
        { file: '/p/main.shade.ts', find: 'double(2.)', delta: 1 },
        { file: '/p/main.shade.ts', find: "'./lib.shade.js'", delta: 3 },
      ],
    },
    {
      name: 'an import that resolves to nothing',
      files: { '/p/main.shade.ts': MAIN },
      diagnosticsOf: ['/p/main.shade.ts'],
      probes: [{ file: '/p/main.shade.ts', find: 'double(2.)', delta: 1 }],
    },
    {
      name: 'an import of a package',
      files: {
        '/p/main.shade.ts': USES_PACKAGE,
        '/p/node_modules/shade-lib/package.json': PACKAGE_JSON,
        '/p/node_modules/shade-lib/src/index.shade.ts': PACKAGE_SHADER,
      },
      diagnosticsOf: ['/p/main.shade.ts'],
      probes: [{ file: '/p/main.shade.ts', find: 'triple(2.)', delta: 1 }],
    },
    {
      name: 'a documented function',
      files: { '/p/a.shade.ts': DOCUMENTED },
      diagnosticsOf: ['/p/a.shade.ts'],
      probes: [{ file: '/p/a.shade.ts', find: 'tint(1.)', delta: 1 }],
    },
    {
      name: 'a plain TypeScript file beside a shader',
      files: { '/p/a.shade.ts': CLEAN, '/p/b.ts': PLAIN_TS },
      diagnosticsOf: ['/p/a.shade.ts', '/p/b.ts'],
    },
  ];

  it('agree on diagnostics, hover and definition for every program', () => {
    expect(cases.length).toBeGreaterThanOrEqual(6);
    const web = drive({ kind: 'web', mode: 'semantic', stripGlobals: true, cases });
    const desktop = drive({ kind: 'desktop', mode: 'semantic', stripGlobals: false, cases });
    expect(web.globalsLeft).toEqual([]);
    for (const [index, result] of web.results.entries()) {
      const twin = desktop.results[index];
      expect(result.name).toBe(twin.name);
      expect(result.createThrew, result.name).toBeUndefined();
      const webRest = withoutLogs(result);
      const desktopRest = withoutLogs(twin);
      expect(webRest, result.name).toEqual(desktopRest);
    }
    // Not vacuous: the programs were actually answered, with the diagnostics they should have.
    const byName = new Map(web.results.map((r) => [r.name, r]));
    expect(codesOf(byName.get('clean shader')!, '/p/a.shade.ts')).toEqual([]);
    expect(codesOf(byName.get('unknown function (8004)')!, '/p/a.shade.ts')).toEqual([8004]);
    expect(codesOf(byName.get('syntax error')!, '/p/a.shade.ts').length).toBeGreaterThan(0);
    expect(codesOf(byName.get('a relative import')!, '/p/main.shade.ts')).toEqual([]);
    expect(codesOf(byName.get('an import that resolves to nothing')!, '/p/main.shade.ts')).toEqual([
      8072,
    ]);
    expect(codesOf(byName.get('an import of a package')!, '/p/main.shade.ts')).toEqual([]);
    expect(byName.get('a documented function')!.hover[0]).toMatchObject({
      display: 'function tint(x: f32): f32',
    });
  });
});

describe('the web bundle reads through serverHost', () => {
  // `package.json` is served ONLY by `serverHost.readFile` here: the language service host does
  // not have it, neither as a snapshot nor through its own `readFile`.
  const importer: Case = {
    name: 'a package whose manifest only the server can read',
    files: {
      '/p/main.shade.ts': USES_PACKAGE,
      '/p/node_modules/shade-lib/src/index.shade.ts': PACKAGE_SHADER,
    },
    serverOnly: { '/p/node_modules/shade-lib/package.json': PACKAGE_JSON },
    diagnosticsOf: ['/p/main.shade.ts'],
    probes: [{ file: '/p/main.shade.ts', find: 'triple(2.)', delta: 1 }],
  };

  it('resolves an import whose package.json only the server host can read', () => {
    const web = drive({ kind: 'web', mode: 'semantic', stripGlobals: true, cases: [importer] });
    const [result] = web.results;
    expect(codesOf(result, '/p/main.shade.ts')).toEqual([]);
    // The hover on the imported name comes from the imported file, which proves the import was
    // resolved rather than merely not reported.
    expect(result.hover[0]).toMatchObject({
      display: expect.stringContaining('triple(x: f32): f32'),
    });
    expect(result.definition[0]).toMatchObject({
      definitions: [{ fileName: '/p/node_modules/shade-lib/src/index.shade.ts', name: 'triple' }],
    });
  });

  it('leaves the same import unresolved through the desktop bundle, which asks the language service host', () => {
    // The control: the desktop entry does not read through `serverHost`, so the manifest is not
    // found. If both resolved, the test above would not be about `serverHost`.
    const desktop = drive({
      kind: 'desktop',
      mode: 'semantic',
      stripGlobals: false,
      cases: [importer],
    });
    expect(codesOf(desktop.results[0], '/p/main.shade.ts')).not.toEqual([]);
  });
});
