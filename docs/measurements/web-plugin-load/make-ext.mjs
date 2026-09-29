// Generates ./ext for one plugin-bundle variant: node make-ext.mjs esm|cjs|esm-main
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const variant = process.argv[2] ?? 'esm';
const root = join(dirname(fileURLToPath(import.meta.url)), 'ext');
rmSync(root, { recursive: true, force: true });
const put = (rel, text) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

const PLUGIN =
  variant === 'esm-scoped' ? '@typeshade/web-probe-plugin' : 'typeshade-web-probe-plugin';

put(
  'package.json',
  JSON.stringify(
    {
      name: 'web-probe',
      displayName: 'TypeShade web probe',
      publisher: 'typeshade',
      version: '0.0.1',
      engines: { vscode: '^1.90.0' },
      browser: './extension.js',
      activationEvents: ['onLanguage:typescript', 'workspaceContains:**/*.ts'],
      contributes: {
        typescriptServerPlugins: [{ name: PLUGIN, enableForWorkspaceTypeScriptVersions: true }],
      },
    },
    null,
    2,
  ),
);

// The web extension's own browser entry: does nothing but log, so activation is visible.
put(
  'extension.js',
  `
exports.activate = function activate() { console.log('[probe-ext] web extension activated'); };
exports.deactivate = function deactivate() {};
`,
);

// The plugin body, shared by both module formats.
const body = `
function init(modules) {
  const ts = modules.typescript;
  return {
    create(info) {
      const logger = info.project.projectService.logger;
      const log = (m) => { logger.info('[probe-plugin] ' + m); try { console.log('[probe-plugin] ' + m); } catch (e) {} };
      log('create() ran; ts ' + ts.version + '; project ' + info.project.getProjectName() + '; config ' + JSON.stringify(info.config));
      try {
        const h = info.serverHost;
        const txt = h.readFile('/vscode-test-web/mount/a.ts');
        log('env: readFile via serverHost length=' + (txt ? txt.length : txt) + ' fileExists=' + h.fileExists('/vscode-test-web/mount/a.ts')
          + ' | fetch=' + typeof fetch + ' importScripts=' + typeof importScripts + ' Worker=' + typeof Worker
          + ' WebAssembly=' + typeof WebAssembly + ' SharedArrayBuffer=' + typeof SharedArrayBuffer + ' crossOriginIsolated=' + (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated)
          + ' require=' + typeof require + ' process=' + typeof process + ' self=' + typeof self);
      } catch (e) { log('env probe threw ' + e); }
      const ls = info.languageService;
      const proxy = Object.create(null);
      for (const k of Object.keys(ls)) { proxy[k] = (...a) => ls[k].apply(ls, a); }
      const diag = (fileName, text, sf) => ({
        file: sf, start: 0, length: 1, messageText: text,
        category: ts.DiagnosticCategory.Warning, code: 99999, source: 'typeshade-probe',
      });
      proxy.getSyntacticDiagnostics = (fileName) => {
        const prior = ls.getSyntacticDiagnostics(fileName);
        if (!fileName.endsWith('.ts')) return prior;
        log('getSyntacticDiagnostics ' + fileName);
        return [...prior, diag(fileName, 'TSHADE_PROBE_SYNTACTIC', ls.getProgram() && ls.getProgram().getSourceFile(fileName))];
      };
      proxy.getSemanticDiagnostics = (fileName) => {
        const prior = ls.getSemanticDiagnostics(fileName);
        if (!fileName.endsWith('.ts')) return prior;
        log('getSemanticDiagnostics ' + fileName);
        return [...prior, diag(fileName, 'TSHADE_PROBE_SEMANTIC', ls.getProgram() && ls.getProgram().getSourceFile(fileName))];
      };
      proxy.getQuickInfoAtPosition = (fileName, position) => {
        const prior = ls.getQuickInfoAtPosition(fileName, position);
        if (!prior) return prior;
        log('getQuickInfoAtPosition ' + fileName + ' ' + position);
        return { ...prior, displayParts: [...(prior.displayParts || []), { kind: 'text', text: ' TSHADE_PROBE_QUICKINFO' }] };
      };
      return proxy;
    },
  };
}
`;

const pkg = { name: PLUGIN, version: '0.0.1' };
const dir = `node_modules/${PLUGIN}`;
if (variant === 'esm' || variant === 'esm-scoped') {
  put(`${dir}/plugin.mjs`, body + '\nexport default init;\n');
  Object.assign(pkg, { main: './plugin.mjs', browser: './plugin.mjs', type: 'module' });
} else if (variant === 'esm-js') {
  // ES module syntax in a plain .js file, no "type" field: the browser does not care about "type".
  put(`${dir}/dist/plugin.js`, body + '\nexport default init;\n');
  Object.assign(pkg, { main: './dist/plugin.js', browser: './dist/plugin.js' });
} else if (variant === 'esm-nobrowser') {
  put(`${dir}/plugin.mjs`, body + '\nexport default init;\n');
  Object.assign(pkg, { main: './plugin.mjs', type: 'module' });
} else if (variant === 'esm-multi') {
  // A default export plus a relative static import: a bundle may be split into several files.
  put(`${dir}/helper.mjs`, "export const helperLoaded = 'helper.mjs was imported';\n");
  put(
    `${dir}/plugin.mjs`,
    "import { helperLoaded } from './helper.mjs';\n" +
      body.replace("log('create() ran;", "log(helperLoaded); log('create() ran;") +
      '\nexport default init;\n',
  );
  Object.assign(pkg, { main: './plugin.mjs', browser: './plugin.mjs', type: 'module' });
} else if (variant === 'cjs') {
  put(`${dir}/plugin.js`, body + '\nmodule.exports = init;\n');
  Object.assign(pkg, { main: './plugin.js', browser: './plugin.js' });
} else {
  throw new Error('variant: esm | esm-scoped | esm-js | esm-nobrowser | esm-multi | cjs');
}
put(`node_modules/${PLUGIN}/package.json`, JSON.stringify(pkg, null, 2));

// The web test module must sit inside the extension for the ext host to run it.
put(
  'test/index.js',
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tests/index.js'), 'utf8'),
);

console.log('ext generated, variant', variant);
