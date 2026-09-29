// === The build: esbuild, not tsc ===
//
// Three of the artifacts are CommonJS bundles, because tsserver `require`s a plugin, the VS Code
// extension host loads the extension's `main` the same way, and an MCP client runs the server's
// `bin` under node; and all three have to carry the compiler with them: it is a pinned submodule
// rather than an installed dependency until it publishes (`docs/design.md` §2). `tsc` does the
// type-checking and emits nothing. The fourth artifact, the web plugin, is an ES module for a
// browser worker and is described where it is built.
//
// The bundles are NOT configured alike, and the difference is load-bearing.
//
//   plugin      `typescript` is INLINED, and that is a correction: it was external until a real
//               VS Code proved it could not be. The bundled compiler builds a TypeScript program
//               of its own, with `lib: []` and the ambient `SHADE_DTS`, so the bundle requires
//               `typescript` at run time whatever the plugin itself does. External, that require
//               resolves by node walking up from wherever the bundle sits: in this repository it
//               finds the workspace's own copy, and in a packaged `.vsix` it finds nothing at
//               all. Neither is the host's instance, and the first is worse than the second,
//               because it works. `packages/vscode-typeshade/test-electron/` ran the plugin in
//               VS Code 1.137, whose tsserver is TypeScript 6.0.3, and the two `SyntaxKind`
//               tables disagreed on the first request. What stays host-owned is every node that
//               came from tsserver: the plugin reads those with `modules.typescript`, the
//               instance tsserver handed it, and never with the bundled copy;
//               `packages/tsserver-plugin/src/directive.ts` is where that rule lives.
//   extension   `typescript` is INLINED. The VS Code extension host injects `vscode` and
//               resolves everything else from what the `.vsix` ships, and the preview panel
//               runs a language service of its own (§4), so an external `typescript` would
//               throw on its first require in a packaged extension while working perfectly in
//               the development host, where `node_modules` is on disk.
//   MCP server  `typescript` is EXTERNAL again, for a third reason: the server is an npm
//               package with a `bin`, so npm installs `typescript` beside it as an ordinary
//               dependency, and nothing hands it one. The MCP SDK and zod are external too:
//               the SDK's own build carries ajv, ajv-formats and three of ajv's dependencies,
//               and a bundle of that would republish their code without their license notices.
//               Installed by npm, each package keeps its own, and the bundle holds only the
//               compiler and this repository, both under the LICENSE the publish copies in
//               (`docs/agents.md` §3.6).

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The compiler's published specifiers, resolved to the pinned submodule. The same four
 *  mappings are in `tsconfig.base.json` `paths` for type-checking and in `vitest.config.mts`
 *  for the tests; all three go away together on the day `typeshade` is on npm. */
const alias = {
  typeshade: join(root, 'vendor/typeshade/src/index.ts'),
  'typeshade/language-service': join(root, 'vendor/typeshade/src/language-service/index.ts'),
  'typeshade/debug': join(root, 'vendor/typeshade/src/debug.ts'),
  'typeshade/runtime': join(root, 'vendor/typeshade/src/runtime.ts'),
};

/** What every bundle shares: it is bundled, and the compiler's specifiers resolve to the
 *  submodule. */
const shared = {
  bundle: true,
  alias,
  logLevel: 'warning',
};

/** What the three node bundles add to `shared`.
 *
 *  `import.meta.url` needs a definition because the compiler is ESM source going into a
 *  CommonJS bundle, and one module reads it: `core/diagnostics/loc.ts` derives the path prefix
 *  it uses to tell its own stack frames from an author's. That module already falls back to a
 *  literal when `import.meta` is absent, so the bundle would work without this; defining it
 *  keeps the derivation correct instead of silently taking the fallback, and it turns off an
 *  esbuild warning on every build that would otherwise train the eye to ignore warnings. */
const nodeOnly = {
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  define: { 'import.meta.url': '__typeshadeModuleUrl' },
  banner: {
    js: "const __typeshadeModuleUrl = require('node:url').pathToFileURL(__filename).href;",
  },
};

/** The node bundles' options, which is what `bundle()` builds from unless it is given others. */
const common = { ...shared, ...nodeOnly };

/**
 * Builds one package.
 *
 * @param {{ entry: string, outfile: string, external: string[], footer?: string,
 *   define?: Record<string, string>, base?: import('esbuild').BuildOptions }} options - the entry
 *   point, where the bundle goes, what stays external, any trailing source, any build-time
 *   constants, and the options every bundle of this kind shares (`common`, the node bundles',
 *   unless another set is given).
 * @returns {Promise<{ outfile: string, bytes: number }>} what was written.
 */
async function bundle({ entry, outfile, external, footer, define, base = common }) {
  const result = await build({
    ...base,
    entryPoints: [join(root, entry)],
    outfile: join(root, outfile),
    external,
    ...(footer === undefined ? {} : { footer: { js: footer } }),
    define: { ...base.define, ...define },
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
    external: [],
    // tsserver calls the module object itself. esbuild emits ESM exports as a namespace object,
    // and a namespace object is not callable, so this is the line that makes the package's
    // export the factory. `index.test.ts` pins the source shape and `build.test.ts` the built
    // one, because a plugin with the wrong export loads without an error and never runs.
    footer: '\nmodule.exports = module.exports.init\n',
  }),
);

// The plugin for VS Code for the Web (`docs/playground-bridge.md` §4): a second bundle of the
// same plugin, and the only one that is an ES module. The web extension host imports the file
// the plugin package's `browser` field names and calls its default export inside the tsserver
// web worker, where there is no `require`, no `process` and no `Buffer`. It is not `common`'s:
// the platform, the format, the target, the `import.meta.url` definition and the banner are all
// the node bundles', and none of them applies.
//
//   `.js`        not `.mjs`: the CDN serving an installed extension was measured to send `.js` as
//                `application/javascript`, and a browser does not read a package's `type`.
//   `typescript` inlined, for the desktop plugin's reason: the compiler reads `ts.SyntaxKind`
//                when it loads, so it needs a copy of its own, and the host's instance stays the
//                one every tsserver node is read with.
//   `process.browser`  is `true`. The bundled TypeScript decides it is running under node when
//                `process.nextTick` exists, `process.browser` is falsy and `require` exists, and
//                then calls `os.platform()` through a `require` that esbuild stubbed for the
//                browser. The definition makes it take the browser path whatever the worker
//                provides. `build-web.test.ts` loads the bundle with `process` deleted.
//   `minify`     is the difference between 11.7 MB and about 4.6 MB for a worker to fetch on every
//                start. There is no `keepNames`: function names in a log stack are not worth
//                the bytes, and the one reader of stack frames (`loc.ts`) runs only while
//                tracing is on.
built.push(
  await bundle({
    entry: 'packages/tsserver-plugin/src/web.ts',
    outfile: 'packages/tsserver-plugin/dist/index.web.js',
    external: [],
    define: { 'process.browser': 'true' },
    base: {
      ...shared,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      minify: true,
    },
  }),
);

built.push(
  await bundle({
    entry: 'packages/vscode-typeshade/src/extension.ts',
    outfile: 'packages/vscode-typeshade/dist/extension.js',
    external: ['vscode'],
  }),
);

/** The compiler the bundles carry, as `version (commit)`, for the MCP server to report: an agent
 *  told which commit it is talking to can tell a language change from its own mistake. The
 *  commit is read from the submodule's checkout, and a build outside git says so rather than
 *  failing. */
function compilerVersion() {
  const vendor = join(root, 'vendor/typeshade');
  const { version } = JSON.parse(readFileSync(join(vendor, 'package.json'), 'utf8'));
  let commit = 'unknown commit';
  try {
    commit = execFileSync('git', ['-C', vendor, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    // Not a git checkout (an unpacked source archive): the version alone is still true.
  }
  return `${version} (${commit})`;
}

const mcpPackage = JSON.parse(readFileSync(join(root, 'packages/mcp-server/package.json'), 'utf8'));

built.push(
  await bundle({
    entry: 'packages/mcp-server/src/index.ts',
    outfile: 'packages/mcp-server/dist/index.js',
    external: ['typescript', '@modelcontextprotocol/server', 'zod'],
    define: {
      __TYPESHADE_MCP_VERSION__: JSON.stringify(mcpPackage.version),
      __TYPESHADE_COMPILER__: JSON.stringify(compilerVersion()),
    },
  }),
);

// The Canvas tab's webview script (`docs/playground-bridge.md` §3): the only bundle that runs in a
// browser context rather than in node, so it is not `common`'s. An IIFE, because a webview loads
// it with a plain `<script>` tag and a module script would need a second content security policy
// entry. It carries `typeshade/runtime` (the program runtime, compiler change 0025) and nothing
// of the compiler: the extension host compiles and posts the manifests, and `webview.test.ts`
// holds the bundle to that, since a webview that quietly grew the whole compiler would still work.
const webview = await build({
  ...shared,
  entryPoints: [join(root, 'packages/vscode-typeshade/src/webview/canvas.ts')],
  outfile: join(root, 'packages/vscode-typeshade/dist/webview/canvas.js'),
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  metafile: true,
});
built.push({
  outfile: 'packages/vscode-typeshade/dist/webview/canvas.js',
  bytes: webview.metafile.outputs[Object.keys(webview.metafile.outputs)[0]].bytes,
});

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
);

built.push(
  await bundle({
    entry: 'packages/vscode-typeshade/test-electron/main.ts',
    outfile: 'packages/vscode-typeshade/dist/test-electron/main.js',
    external: ['@vscode/test-electron'],
  }),
);

for (const { outfile, bytes } of built) {
  console.log(`${outfile.padEnd(48)} ${(bytes / 1024).toFixed(0)} KB`);
}
