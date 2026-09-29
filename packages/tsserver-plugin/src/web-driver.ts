// === A node process that behaves like the web worker, for the web bundle's tests ===
//
// Test-only. The web plugin runs inside a tsserver web worker, where there is no `require`, no
// `process`, no `Buffer` and no `setImmediate`, and a browser cannot be started from a unit
// test. This is the closest a node process gets: it loads `typescript` for the host's own
// instance FIRST (the host in a worker has one of its own too), then deletes those globals, and
// only then imports the bundle under test, so anything the bundle does at load time or on its
// first request that reaches for one of them throws here as it would in the worker.
//
// It is a string rather than a module because the test runs it as `node driver.mjs config.json`
// in a directory of its own: the bundle under test is copied there as `.mjs`, and node reads a
// `.js` with no `type` as CommonJS. It runs the SAME cases against either bundle, so a test
// can compare the two outputs.
//
// The config is `{ bundle, kind, mode, stripGlobals, nodeLikeShim, tsFrom, cases }`. A case is
// `{ name, files, serverOnly?, diagnosticsOf, probes }`: `files` are what the language service
// host serves (snapshots, its own `readFile`), `serverOnly` are files ONLY `serverHost.readFile`
// serves, and a probe is `{ file, find, delta }` naming a position by text, for hover and
// definition. The output is one JSON line.

/** The driver's source. No backticks and no `${`: it sits in a template literal. */
export const DRIVER = String.raw`
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const ts = createRequire(config.tsFrom)('typescript');
const desktop = config.kind === 'desktop' ? createRequire(config.bundle)(config.bundle) : undefined;

if (config.stripGlobals) {
  for (const name of ['process', 'Buffer', 'setImmediate', 'clearImmediate', 'require']) {
    delete globalThis[name];
  }
}
if (config.nodeLikeShim) {
  // What a bundler's or a worker's shim can leave behind: a \`process\` with a \`nextTick\` and a
  // \`require\` that cannot load anything. TypeScript calls a host node-like when it sees both and
  // no \`process.browser\`, and then reads \`os.platform()\` from a module that is not there.
  globalThis.process = { nextTick: (f, ...a) => queueMicrotask(() => f(...a)), env: {}, argv: [] };
  globalThis.require = () => {
    throw new Error('require is not available here');
  };
}
const globalsLeft = ['process', 'Buffer', 'setImmediate', 'require'].filter(
  (name) => typeof globalThis[name] !== 'undefined',
);

const factory =
  config.kind === 'web' ? (await import(pathToFileURL(config.bundle).href)).default : desktop;

const text = (message) => (typeof message === 'string' ? message : message.messageText);
const attempt = (thunk) => {
  try {
    return thunk();
  } catch (error) {
    return { threw: String(error && error.stack ? error.stack : error) };
  }
};

function run(c) {
  const texts = new Map(Object.entries(c.files));
  const serverTexts = new Map(Object.entries(c.serverOnly ?? {}));
  const host = {
    getScriptFileNames: () => [...texts.keys()],
    getScriptVersion: () => '1',
    getScriptSnapshot: (f) => (texts.has(f) ? ts.ScriptSnapshot.fromString(texts.get(f)) : undefined),
    getCurrentDirectory: () => '/p',
    getCompilationSettings: () => ({
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noLib: true,
      noResolve: true,
      types: [],
      strict: true,
      noEmit: true,
    }),
    getDefaultLibFileName: () => '/lib.d.ts',
    fileExists: (f) => texts.has(f),
    readFile: (f) => texts.get(f),
    directoryExists: () => true,
    getDirectories: () => [],
    getProjectVersion: () => '1',
  };
  const mode =
    config.mode === 'partial' ? ts.LanguageServiceMode.PartialSemantic : ts.LanguageServiceMode.Semantic;
  const service = ts.createLanguageService(host, ts.createDocumentRegistry(), mode);
  const logs = [];
  const info = {
    languageService: service,
    languageServiceHost: host,
    serverHost: { readFile: (f) => serverTexts.get(f) ?? texts.get(f) },
    project: { projectService: { logger: { info: (m) => logs.push(m) } } },
  };
  const decorated = attempt(() => factory({ typescript: ts }).create(info));
  const result = { name: c.name, diagnostics: {}, hover: [], definition: [] };
  if (decorated.threw) return { ...result, createThrew: decorated.threw };
  for (const f of c.diagnosticsOf) {
    result.diagnostics[f] = attempt(() =>
      [...decorated.getSyntacticDiagnostics(f), ...decorated.getSemanticDiagnostics(f)].map((d) => ({
        code: d.code,
        source: d.source,
        category: d.category,
        start: d.start,
        length: d.length,
        text: text(d.messageText),
      })),
    );
  }
  for (const p of c.probes ?? []) {
    const at = c.files[p.file].indexOf(p.find) + p.delta;
    result.hover.push(
      attempt(() => {
        const quick = decorated.getQuickInfoAtPosition(p.file, at);
        return quick && {
          kind: quick.kind,
          textSpan: quick.textSpan,
          display: (quick.displayParts ?? []).map((part) => part.text).join(''),
          documentation: (quick.documentation ?? []).map((part) => part.text).join(''),
        };
      }),
    );
    result.definition.push(
      attempt(() => {
        const found = decorated.getDefinitionAndBoundSpan(p.file, at);
        return found && {
          textSpan: found.textSpan,
          definitions: (found.definitions ?? []).map((d) => ({
            fileName: d.fileName,
            textSpan: d.textSpan,
            name: d.name,
            kind: d.kind,
          })),
        };
      }),
    );
  }
  result.decorationFailed = logs.some((line) => line.includes('decoration failed'));
  result.logs = logs;
  return result;
}

console.log(JSON.stringify({ globalsLeft, results: config.cases.map(run) }));
`;
