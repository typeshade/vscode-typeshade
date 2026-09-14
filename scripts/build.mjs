// === The build: esbuild, not tsc ===
//
// Both artifacts are CommonJS bundles, because tsserver `require`s a plugin and the VS Code
// extension host loads the extension's `main` the same way, and both have to carry the compiler
// with them: it is a pinned submodule rather than an installed dependency until it publishes
// (`docs/design.md` §2). `tsc` does the type-checking and emits nothing.
//
// The two bundles differ only in what the host injects: `vscode` for the extension, nothing for
// the plugin.
//
// Both INLINE `typescript`, and the plugin's copy is a correction: it was external until a real
// VS Code proved it could not be.
//
//   why it is inlined   The bundled compiler builds a TypeScript program of its own, with
//               `lib: []` and the ambient `SHADE_DTS`, so the bundle requires `typescript` at
//               run time whatever the plugin itself does. External, that require resolves by
//               node walking up from wherever the bundle sits: in this repository it finds the
//               workspace's own 5.6.3, and in a packaged `.vsix` it finds nothing at all.
//               Neither is the host's instance, and the first is worse than the second, because
//               it works. `packages/vscode-typeshade/test-electron/` ran the plugin in
//               VS Code 1.137, whose tsserver is TypeScript 6.0.3, and the two `SyntaxKind`
//               tables disagreed on the first request.
//   what stays host-owned   Every node that came from tsserver. The plugin reads those with
//               `modules.typescript`, the instance tsserver handed it, and never with the
//               bundled copy; `packages/tsserver-plugin/src/directive.ts` is where that rule
//               lives and what it cost when it was broken.
//   extension   The VS Code extension host injects `vscode` and resolves everything else from
//               what the `.vsix` ships, and the preview panel runs a language service of its
//               own (§4), so an external `typescript` would throw on its first require in a
//               packaged extension while working perfectly in the development host, where
//               `node_modules` is on disk.

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The compiler's published specifiers, resolved to the pinned submodule. The same three
 *  mappings are in `tsconfig.base.json` `paths` for type-checking and in `vitest.config.mts`
 *  for the tests; all three go away together on the day `typeshade` is on npm. */
const alias = {
  typeshade: join(root, 'vendor/typeshade/src/index.ts'),
  'typeshade/language-service': join(root, 'vendor/typeshade/src/language-service/index.ts'),
  'typeshade/debug': join(root, 'vendor/typeshade/src/debug.ts'),
}

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
}

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
  })
  const output = result.metafile.outputs[Object.keys(result.metafile.outputs)[0]]
  return { outfile, bytes: output.bytes }
}

const built = []

built.push(
  await bundle({
    entry: 'packages/tsserver-plugin/src/index.ts',
    outfile: 'packages/tsserver-plugin/dist/index.js',
    external: [],
    // tsserver calls the module object itself. esbuild emits ESM exports as a namespace object,
    // and a namespace object is not callable, so this is the line that makes the package's
    // export the factory. `index.test.ts` pins the source shape and `build.test.ts` the built
    // one, because a plugin with the wrong export loads without an error and never runs.
    footer: '\nmodule.exports = module.exports.init\n',
  }),
)

built.push(
  await bundle({
    entry: 'packages/vscode-typeshade/src/extension.ts',
    outfile: 'packages/vscode-typeshade/dist/extension.js',
    external: ['vscode'],
  }),
)

// The electron suite and its launcher, built the same way for the same reason: the extension
// host loads the suite with `require`, and the launcher runs under plain node. Neither belongs in
// the `.vsix` (§7's `.vscodeignore` keeps `dist/test-electron/` out), and both are built here
// rather than in their own script so there is one place that knows how a bundle is made.
built.push(
  await bundle({
    entry: 'packages/vscode-typeshade/test-electron/suite.ts',
    outfile: 'packages/vscode-typeshade/dist/test-electron/suite.js',
    external: ['vscode'],
  }),
)

built.push(
  await bundle({
    entry: 'packages/vscode-typeshade/test-electron/main.ts',
    outfile: 'packages/vscode-typeshade/dist/test-electron/main.js',
    external: ['@vscode/test-electron'],
  }),
)

for (const { outfile, bytes } of built) {
  console.log(`${outfile.padEnd(48)} ${(bytes / 1024).toFixed(0)} KB`)
}
