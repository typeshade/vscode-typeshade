// === One measurement, in a process that does nothing else ===
//
// Run by `measure.ts`, never by hand: it writes the fixture and the bundle this reads, spawns
// this file under `node --expose-gc` once per mode per run, and aggregates the JSON line each
// run prints.
//
// Plain JavaScript, and node rather than bun, for two reasons the first version of this
// measurement got wrong. tsserver runs under node, so a number measured under bun is a number
// about a runtime the plugin will never be loaded into. And a heap delta taken in a process
// that is also holding an unrelated ~85 MB program measures the collector's timing as much as
// the thing being measured, so each mode gets a process of its own and every reading is taken
// after a forced collection.
//
// The two modes answer different questions:
//
//   project  what the editor does today with no plugin: one language service over the whole
//            fixture, with the standard library, and the diagnostics it reports on the shader
//            files, every one of which is false.
//   plugin   what the plugin adds: requiring its bundle (once per tsserver process), then
//            building the TypeShade program and answering for every shader file (once per
//            project), then one edit answered (once per keystroke).

import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

/** Where `measure.ts` wrote the fixture and the bundle. */
const FIXTURE_DIR = process.argv[3];
/** The esbuild bundle of the compiler's `./language-service` subpath. */
const BUNDLE = process.argv[4];
/** How many edits the warm figure averages over. */
const EDIT_COUNT = 20;

/** Live heap in megabytes, after a full collection. `--expose-gc` is required, and the caller
 *  passes it; without it a reading is of an uncollected heap and means nothing. */
function heapMb() {
  if (typeof global.gc !== 'function') {
    throw new Error('run with --expose-gc; a heap reading without a collection is not a reading');
  }
  global.gc();
  global.gc();
  return Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;
}

/** Milliseconds a function took, to one decimal place, with its return value. */
function timed(fn) {
  const start = performance.now();
  const value = fn();
  return { ms: Math.round((performance.now() - start) * 10) / 10, value };
}

/** Every file of the fixture, split by whether it carries the directive. `SHADE_LIMIT` caps
 *  how many shader files the plugin mode opens, which is how the one-document case the
 *  extension's preview panel holds (`docs/design.md` §4) is measured with the same harness. */
function fixtureFiles() {
  const dir = join(FIXTURE_DIR, 'src');
  const all = readdirSync(dir).map((name) => join(dir, name));
  const shade = all.filter((f) => f.endsWith('.shade.ts'));
  const limit = Number(process.env.SHADE_LIMIT ?? String(shade.length));
  return {
    hostFiles: all.filter((f) => !f.endsWith('.shade.ts')),
    shadeFiles: shade.slice(0, limit),
  };
}

/** The project's language service, standing in for the one tsserver builds: the fixture's own
 *  compiler options, the real standard library, and texts held in memory so an edit needs no
 *  disk write. */
function projectService(ts, files) {
  const texts = new Map();
  const versions = new Map();
  for (const file of files) {
    texts.set(file, readFileSync(file, 'utf8'));
    versions.set(file, 1);
  }
  const host = {
    getScriptFileNames: () => [...texts.keys()],
    getScriptVersion: (file) => String(versions.get(file) ?? 0),
    getScriptSnapshot: (file) => {
      const text = texts.get(file) ?? ts.sys.readFile(file);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => FIXTURE_DIR,
    getCompilationSettings: () => ({
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      strict: true,
      noEmit: true,
    }),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  return {
    service: ts.createLanguageService(host, ts.createDocumentRegistry()),
    edit: (file, text) => {
      texts.set(file, text);
      versions.set(file, (versions.get(file) ?? 1) + 1);
    },
  };
}

/** What the editor costs and reports with no plugin loaded. */
function measureProject() {
  const ts = require('typescript');
  const { hostFiles, shadeFiles } = fixtureFiles();
  const files = [...hostFiles, ...shadeFiles];
  const base = heapMb();
  const { service, edit } = projectService(ts, files);

  const cold = timed(() => {
    let count = 0;
    for (const file of files) {
      count += service.getSemanticDiagnostics(file).length;
      count += service.getSyntacticDiagnostics(file).length;
    }
    return count;
  });
  const afterCold = heapMb();

  const perFile = {};
  let falseTotal = 0;
  for (const file of shadeFiles) {
    const semantic = service.getSemanticDiagnostics(file);
    falseTotal += semantic.length;
    perFile[file.split('/').pop()] = {
      count: semantic.length,
      codes: [...new Set(semantic.map((d) => `TS${d.code}`))].sort(),
    };
  }

  const target = shadeFiles[0];
  const original = readFileSync(target, 'utf8');
  const warm = timed(() => {
    for (let i = 0; i < EDIT_COUNT; i++) {
      edit(target, `${original}\n// edit ${i}\n`);
      service.getSemanticDiagnostics(target);
      service.getSyntacticDiagnostics(target);
    }
  });

  return {
    mode: 'project',
    files: files.length,
    shaders: shadeFiles.length,
    coldMs: cold.ms,
    warmMs: Math.round((warm.ms / EDIT_COUNT) * 10) / 10,
    heapMb: Math.round((afterCold - base) * 10) / 10,
    diagnostics: cold.value,
    falseOnShaders: falseTotal,
    perFile,
  };
}

/** What the plugin's own program costs, in the three phases that are paid at different times. */
function measurePlugin() {
  const { shadeFiles } = fixtureFiles();

  // `typescript` is loaded BEFORE the baseline, because tsserver has one loaded before it asks
  // for any plugin and the plugin must not be charged for the host's copy.
  //
  // What the plugin IS charged for is its own. The bundle carries `typescript` rather than
  // leaving it external, which an earlier version of this measurement did on the argument that
  // tsserver already has one. It does, but not one the bundle can reach: external resolves by
  // node walking up from the bundle's own path, which finds a different copy in a checkout and
  // nothing at all in a packaged extension. So the second instance is real, this baseline does
  // not hide it, and the require phase below is the honest number rather than a third of it.
  require('typescript');
  const base = heapMb();

  // Phase 1, once per tsserver process: loading the plugin's bundled code. tsserver pays this
  // synchronously while the project loads, which is why it is measured rather than skipped.
  const required = timed(() => require(BUNDLE));
  const afterRequire = heapMb();
  const { createTypeshadeLanguageService } = required.value;

  // Phase 2, once per project: the second TypeScript program, built and asked for every
  // shader file's diagnostics.
  const texts = new Map(shadeFiles.map((file) => [file, readFileSync(file, 'utf8')]));
  const built = timed(() => {
    const shade = createTypeshadeLanguageService({ readDocument: (uri) => texts.get(uri) });
    for (const [uri, text] of texts) shade.openDocument(uri, text, 1);
    let count = 0;
    for (const uri of texts.keys()) count += shade.getDiagnostics(uri).length;
    return { shade, count };
  });
  const afterBuild = heapMb();

  // Phase 3, once per keystroke.
  const target = shadeFiles[0];
  const original = texts.get(target);
  const warm = timed(() => {
    for (let i = 0; i < EDIT_COUNT; i++) {
      built.value.shade.updateDocument(target, `${original}\n// edit ${i}\n`, i + 2);
      built.value.shade.getDiagnostics(target);
    }
  });

  return {
    mode: 'plugin',
    shaders: shadeFiles.length,
    requireMs: required.ms,
    requireHeapMb: Math.round((afterRequire - base) * 10) / 10,
    buildMs: built.ms,
    buildHeapMb: Math.round((afterBuild - afterRequire) * 10) / 10,
    retainedHeapMb: Math.round((afterBuild - base) * 10) / 10,
    warmMs: Math.round((warm.ms / EDIT_COUNT) * 10) / 10,
    diagnostics: built.value.count,
  };
}

const mode = process.argv[2];
const report = mode === 'project' ? measureProject() : measurePlugin();
process.stdout.write(`${JSON.stringify({ ...report, runtime: `node ${process.version}` })}\n`);
