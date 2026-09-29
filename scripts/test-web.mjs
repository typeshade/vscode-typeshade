// === The web suite: the packaged extension in VS Code for the Web ===
//
// Run with `npm run test:web` from the repository root, which builds, stages the package
// (`scripts/package-extension.mjs`) and then runs this. It serves a real browser build of VS Code
// with `@vscode/test-web`, opens the extension in a headless Chromium and runs
// `packages/vscode-typeshade/test-web/suite.ts` inside the web extension host (`docs/design.md`
// §6, `docs/playground-bridge.md` §4).
//
// What runs is the directory `package-extension.mjs` packs the `.vsix` from, byte for byte, copied
// to `out/web-extension` with the built suite beside it: `@vscode/test-web` only runs a test module
// that sits inside the extension under test. So a manifest without `browser`, or a plugin package
// whose `browser` names a file the package lacks, fails here as it would for a user.
//
// The environment:
//
//   TYPESHADE_WEB_COMMIT     the VS Code build, by commit. Always a commit: `quality` alone serves
//                            whatever is newest that day, and a suite that changes under an
//                            unchanged repository is not a check. Default: 1.139.1.
//   TYPESHADE_WEB_COI        whether the page is cross-origin isolated, `true` (default) or
//                            `false`. Without isolation TypeScript's semantic server does not run
//                            in the browser, and the suite asserts the degraded behaviour instead.
//   TYPESHADE_WEB_DATA_DIR   where the build is downloaded to and read from. `@vscode/test-web`
//                            keeps one build per directory and deletes it when another commit
//                            asks, so the default is one directory per commit,
//                            `.vscode-test-web/<commit>`.
//   TYPESHADE_EXTENSION_PATH the package to run, instead of `out/extension`, as the electron
//                            launcher takes it.
//   TYPESHADE_WEB_PORT       the port the page is served on (the tool's default is 3000).
//   TYPESHADE_WEB_TIMEOUT_MS how long the whole run may take before it is failed, 600000 by default.
//                            A web host that will not load the extension (a manifest without
//                            `browser`) never starts the suite and never reports, so without this
//                            the run hangs until the CI job's own limit.
//   TYPESHADE_WEB_SERVER_LOG set to print the server's access log, which shows what the page and
//                            the extension host fetched.
//
// The browser is Playwright's Chromium: `npx playwright install chromium` once, and
// `PLAYWRIGHT_BROWSERS_PATH` if it lives elsewhere.

import { runTests } from '@vscode/test-web';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'packages/vscode-typeshade');

/** VS Code 1.139.1, the current stable when this suite was written. */
const DEFAULT_COMMIT = '04c0d99f4fb0d8afe6ce4f0c58e31e183ac3e4b1';

const commit = process.env.TYPESHADE_WEB_COMMIT ?? DEFAULT_COMMIT;
if (!/^[0-9a-f]{40}$/.test(commit)) {
  throw new Error(`TYPESHADE_WEB_COMMIT must be a 40 character commit, got ${commit}`);
}

/** Reads a boolean from the environment, and refuses a spelling it does not know. */
function flag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no'].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be true or false, got ${raw}`);
}

const coi = flag('TYPESHADE_WEB_COI', true);
const dataDir = resolve(
  process.env.TYPESHADE_WEB_DATA_DIR ?? join(root, '.vscode-test-web', commit),
);
const stage = resolve(process.env.TYPESHADE_EXTENSION_PATH ?? join(root, 'out/extension'));
const suite = join(pkg, 'dist/test-web/suite.js');

for (const [what, path] of [
  ['the staged extension', join(stage, 'package.json')],
  ['the built web suite', suite],
]) {
  if (!existsSync(path)) {
    throw new Error(`${what} is missing (${path}): run npm run build and package-extension.mjs`);
  }
}

// The extension under test, and the suite inside it.
const extension = join(root, 'out/web-extension');
rmSync(extension, { recursive: true, force: true });
cpSync(stage, extension, { recursive: true });
mkdirSync(join(extension, 'test'), { recursive: true });
cpSync(suite, join(extension, 'test/suite.web.js'));

// The workspace the page opens: the electron suite's fixture, and what the runner asked for, which
// the suite reads to catch a page that is not as isolated as this run said it would be.
const workspace = join(root, 'out/web-fixture');
rmSync(workspace, { recursive: true, force: true });
cpSync(join(pkg, 'test-electron/fixture'), workspace, { recursive: true });
writeFileSync(join(workspace, 'expect.json'), `${JSON.stringify({ coi })}\n`);

console.log(`VS Code for the Web ${commit}, cross-origin isolated: ${coi}`);
console.log(`extension ${stage}`);

const limit = Number(process.env.TYPESHADE_WEB_TIMEOUT_MS ?? 600_000);
if (!Number.isFinite(limit) || limit <= 0) {
  throw new Error(`TYPESHADE_WEB_TIMEOUT_MS must be a number of milliseconds`);
}

/** Rejects after `limit` ms. Unref'd, so a run that finishes does not wait for it. */
const watchdog = new Promise((_, reject) => {
  setTimeout(
    () =>
      reject(
        new Error(
          `the web suite did not finish within ${limit} ms. A web host that does not load the ` +
            'extension never runs the suite and never says so: look above for "not a web ' +
            'extension" or "No extension host found", which mean the manifest has no "browser" ' +
            'entry. Otherwise a case is stuck, and the server log (TYPESHADE_WEB_SERVER_LOG) ' +
            'shows what the page was fetching.',
        ),
      ),
    limit,
  ).unref();
});

try {
  await Promise.race([
    runTests({
      browserType: 'chromium',
      headless: true,
      coi,
      quality: 'stable',
      commit,
      testRunnerDataDir: dataDir,
      extensionDevelopmentPath: extension,
      extensionTestsPath: join(extension, 'test/suite.web.js'),
      folderPath: workspace,
      // The browser's console is where the suite's per-case lines appear.
      verbose: true,
      printServerLog: process.env.TYPESHADE_WEB_SERVER_LOG !== undefined,
      ...(process.env.TYPESHADE_WEB_PORT ? { port: Number(process.env.TYPESHADE_WEB_PORT) } : {}),
    }),
    watchdog,
  ]);
} catch (error) {
  console.error(error);
  // The browser and the server outlive a rejected race; nothing else is left to wait for.
  process.exit(1);
}
