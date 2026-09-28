// === Launching a real VS Code with the extension in it ===
//
// Run with `npm run test:electron` from the repository root. It downloads a VS Code build the
// first time (327 MB) and needs a display: on a headless machine, including CI, it runs under
// `xvfb-run`. `docs/design.md` §6 records what this container could and could not do with it,
// and why this job is separate from `npm run check`.

import { runTests } from '@vscode/test-electron';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file only ever runs as its BUILT bundle, `dist/test-electron/main.js`, which is two
// levels under the package root; the source it is built from is one level under. Anchoring on
// the bundle's own location is what the first version got wrong, and the symptom was a require
// for `dist/dist/test-electron/suite.js` inside the extension host, four frames deep in
// VS Code's own loader.
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '../..');
// `TYPESHADE_EXTENSION_PATH` runs the suite against a packaged extension instead: the directory
// `scripts/package-extension.mjs` packs the .vsix from, which is what the .vsix unpacks to. The
// suite and its fixture stay this package's.
const extensionDevelopmentPath = process.env.TYPESHADE_EXTENSION_PATH
  ? resolve(process.env.TYPESHADE_EXTENSION_PATH)
  : packageRoot;

async function main(): Promise<void> {
  await runTests({
    extensionDevelopmentPath,
    // The built suite, not its source: the host loads it with `require`, and it has to be one
    // CommonJS file with `vscode` left external, which is what `scripts/build.mjs` produces.
    extensionTestsPath: resolve(packageRoot, 'dist/test-electron/suite.js'),
    launchArgs: [
      resolve(packageRoot, 'test-electron/fixture'),
      // A user's own extensions would change what diagnostics arrive, which is the one thing
      // this suite asserts; `--disable-gpu` is what the VS Code team documents for a headless
      // runner, and without it the launch fails on a machine with no GPU.
      '--disable-extensions',
      '--disable-gpu',
      '--no-sandbox',
    ],
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
