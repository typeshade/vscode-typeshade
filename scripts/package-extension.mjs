// === The extension's .vsix: staged in a clean directory, then packed by vsce ===
//
// `docs/design.md` §7. Run after `npm run build`: `node scripts/package-extension.mjs`, and the
// package lands at `out/vscode-typeshade-<version>.vsix`, with the directory it was packed from
// at `out/extension`, which is exactly what the `.vsix` unpacks to. The electron suite runs
// against that directory (`TYPESHADE_EXTENSION_PATH`), so what CI tests is what is published.
//
// Why a staging directory. vsce packs the directory the manifest sits in, and
// `packages/vscode-typeshade/` holds the sources, the tests and a manifest with workspace
// dependencies. The stage holds only what ships:
//
//   package.json          the extension's manifest, without its scripts and dev dependencies,
//                         and with the plugin as its one dependency
//   dist/extension.js     the extension's bundle
//   dist/webview/canvas.js
//                         the Canvas tab's webview script, which the panel loads by its own uri;
//                         the webview's `localResourceRoots` is this one directory
//   dist/web/extension.js
//                         the extension's entry in VS Code for the Web, which the manifest's
//                         `browser` field names: a stub over `vscode` (`docs/playground-bridge.md`
//                         §4). Desktop reads `main` and never opens it.
//   node_modules/@typeshade/tsserver-plugin/
//                         the plugin's bundles, as a REAL directory with a minimal package.json:
//                         VS Code hands the extension's directory to tsserver as a probe
//                         location, and tsserver resolves the plugin from its node_modules. In
//                         the workspace that path is a symlink npm created; a symlink is not what
//                         a .vsix can carry. `index.js` is the CommonJS bundle the desktop
//                         tsserver requires, named by `main`; `index.web.js` is the ES module the
//                         web tsserver worker imports, named by `browser`, and the web host reads
//                         only `browser`.
//   README.md, CHANGELOG.md
//                         the extension's own, from packages/vscode-typeshade/
//   LICENSE, NOTICE       the repository's, which the extension's directory does not have
//                         (Apache 2.0, section 4d, asks a redistribution to carry the NOTICE)
//
// vsce reads the plugin as a production dependency through `npm list`, which is what makes it
// pack that one directory of node_modules and nothing else.

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'packages/vscode-typeshade');
const stage = join(root, 'out/extension');
/** Pinned, so the tool that packs a release is the one this script was checked with. */
const VSCE = '@vscode/vsce@4.0.0';

const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
const plugin = JSON.parse(
  readFileSync(join(root, 'packages/tsserver-plugin/package.json'), 'utf8'),
);

rmSync(stage, { recursive: true, force: true });
const pluginDir = join(stage, 'node_modules', plugin.name);
mkdirSync(join(stage, 'dist/webview'), { recursive: true });
mkdirSync(join(stage, 'dist/web'), { recursive: true });
mkdirSync(pluginDir, { recursive: true });

copyFileSync(join(pkg, 'dist/extension.js'), join(stage, 'dist/extension.js'));
copyFileSync(join(pkg, 'dist/webview/canvas.js'), join(stage, 'dist/webview/canvas.js'));
copyFileSync(join(pkg, 'dist/web/extension.js'), join(stage, 'dist/web/extension.js'));
copyFileSync(join(root, 'packages/tsserver-plugin/dist/index.js'), join(pluginDir, 'index.js'));
copyFileSync(
  join(root, 'packages/tsserver-plugin/dist/index.web.js'),
  join(pluginDir, 'index.web.js'),
);
writeFileSync(
  join(pluginDir, 'package.json'),
  `${JSON.stringify(
    {
      name: plugin.name,
      version: plugin.version,
      license: plugin.license,
      main: './index.js',
      browser: './index.web.js',
    },
    null,
    2,
  )}\n`,
);
for (const file of ['README.md', 'CHANGELOG.md']) copyFileSync(join(pkg, file), join(stage, file));
for (const file of ['LICENSE', 'NOTICE']) copyFileSync(join(root, file), join(stage, file));

const shipped = { ...manifest };
for (const key of ['scripts', 'devDependencies', 'private']) delete shipped[key];
shipped.dependencies = { [plugin.name]: plugin.version };
writeFileSync(join(stage, 'package.json'), `${JSON.stringify(shipped, null, 2)}\n`);

// The web entry points are checked here because nothing downstream checks them all: vsce verifies
// the extension's `browser` file exists and never opens the plugin's package.json, and a `browser`
// that names a missing file fails in a browser worker, not at build time. Desktop would pass with
// either missing, which is why the electron suite cannot stand in for this.
/** Throws unless the `field` of `dir`'s package.json is a `./` path to a non-empty file. */
function requireEntry(dir, field) {
  const file = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))[field];
  if (typeof file !== 'string' || !file.startsWith('./')) {
    throw new Error(
      `${join(dir, 'package.json')}: "${field}" is ${JSON.stringify(file)}, not a ./ path`,
    );
  }
  const path = join(dir, file);
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) {
    throw new Error(
      `${join(dir, 'package.json')}: "${field}" names ${file}, which the stage lacks`,
    );
  }
  return file;
}
requireEntry(stage, 'main');
const webExtension = requireEntry(stage, 'browser');
requireEntry(pluginDir, 'main');
const webPlugin = requireEntry(pluginDir, 'browser');
console.log(
  `web entry points: ${webExtension} and ${plugin.name}/${webPlugin.replace(/^\.\//, '')}`,
);

const out = join(root, 'out', `${manifest.name}-${manifest.version}.vsix`);
execFileSync('npx', ['-y', VSCE, 'package', '--out', out], { cwd: stage, stdio: 'inherit' });
console.log(`packaged ${out}`);
