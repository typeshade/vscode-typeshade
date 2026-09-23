// === The build: esbuild, not tsc ===
//
// Both artifacts are CommonJS bundles, because tsserver `require`s a plugin and the VS Code
// extension host loads the extension's `main` the same way, and both have to carry the compiler
// with them: it is a pinned submodule rather than an installed dependency until it publishes
// (`docs/design.md` §2). `tsc` does the type-checking and emits nothing.
//
// The two bundles are NOT configured alike, and the difference is load-bearing.
//
//   plugin      `typescript` is EXTERNAL. tsserver hands the plugin its own instance through
//               `modules.typescript`, and a second copy would build nodes the host's `ts.is*`
//               checks do not recognise.
//   extension   `typescript` is INLINED. The VS Code extension host injects `vscode` and
//               resolves everything else from what the `.vsix` ships, and the preview panel
//               runs a language service of its own (§4), so an external `typescript` would
//               throw on its first require in a packaged extension while working perfectly in
//               the development host, where `node_modules` is on disk.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The compiler's published specifiers, resolved to the pinned submodule. The same three
 *  mappings are in `tsconfig.base.json` `paths` for type-checking and in `vitest.config.mts`
 *  for the tests; all three go away together on the day `typeshade` is on npm. */
const alias = {
  typeshade: join(root, 'vendor/typeshade/src/index.ts'),
  'typeshade/language-service': join(root, 'vendor/typeshade/src/language-service/index.ts'),
  'typeshade/debug': join(root, 'vendor/typeshade/src/debug.ts'),
};

/** What every bundle shares.
 *
 *  `import.meta.url` needs a definition because the compiler is ESM source going into a
 *  CommonJS bundle, and one module reads it: `core/diagnostics/loc.ts` derives the path prefix
 *  it uses to tell its own stack frames from an author's. That module already falls back to a
 *  literal when `import.meta` is absent, so the bundle would work without this; defining it
 *  keeps the derivation correct instead of silently taking the fallback, and it turns off an
 *  esbuild warning on every build that would otherwise train the eye to ignore warnings. */
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  alias,
  define: { 'import.meta.url': '__typeshadeModuleUrl' },
  banner: {
    js: "const __typeshadeModuleUrl = require('node:url').pathToFileURL(__filename).href;",
  },
  logLevel: 'warning',
};

/**
 * Builds one package.
 *
 * @param {{ entry: string, outfile: string, external: string[], footer?: string }} options - the
 *   entry point, where the bundle goes, what stays external, and any trailing source.
 * @returns {Promise<{ outfile: string, bytes: number }>} what was written.
 */
async function bundle({ entry, outfile, external, footer }) {
  const result = await build({
    ...common,
    entryPoints: [join(root, entry)],
    outfile: join(root, outfile),
    external,
    ...(footer === undefined ? {} : { footer: { js: footer } }),
    metafile: true,
  });
  const output = result.metafile.outputs[Object.keys(result.metafile.outputs)[0]];
  return { outfile, bytes: output.bytes };
}

const built = [];

built.push(
  await bundle({
    entry: 'packages/tsserver-plugin/src/index.ts',
    outfile: 'packages/tsserver-plugin/dist/index.js',
    external: ['typescript'],
    // tsserver calls the module object itself. esbuild emits ESM exports as a namespace object,
    // and a namespace object is not callable, so this is the line that makes the package's
    // export the factory. `index.test.ts` pins the source shape and `build.test.ts` the built
    // one, because a plugin with the wrong export loads without an error and never runs.
    footer: '\nmodule.exports = module.exports.init\n',
  }),
);

built.push(
  await bundle({
    entry: 'packages/vscode-typeshade/src/extension.ts',
    outfile: 'packages/vscode-typeshade/dist/extension.js',
    external: ['vscode'],
  }),
);

for (const { outfile, bytes } of built) {
  console.log(`${outfile.padEnd(48)} ${(bytes / 1024).toFixed(0)} KB`);
}
