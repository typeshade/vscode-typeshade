// extensionTestsPath: a web-extension-host test module (plain CommonJS, no bundler).
// The web extension host loads a test module as CommonJS, so `vscode` arrives through require.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vscode = require('vscode');

const MARK = 'TSHADE_PROBE';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[probe-test]', ...a);

exports.run = async function run() {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  log(
    'workspaceFolders',
    JSON.stringify((vscode.workspace.workspaceFolders || []).map((f) => f.uri.toString())),
  );
  if (!folder) throw new Error('no workspace folder mounted');
  const uri = vscode.Uri.joinPath(folder.uri, 'a.ts');
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  log('opened', uri.toString(), 'languageId', doc.languageId);
  log(
    'extension list',
    JSON.stringify(
      vscode.extensions.all
        .filter((e) => /typescript|probe/i.test(e.id))
        .map((e) => e.id + ':' + e.isActive),
    ),
  );

  const seen = new Set();
  const start = Date.now();
  let tsExtLogged = false;
  let ok = false;
  while (Date.now() - start < 60000) {
    const diags = vscode.languages.getDiagnostics(uri);
    for (const d of diags) {
      const k = d.source + '|' + d.code + '|' + d.message;
      if (!seen.has(k)) {
        seen.add(k);
        log('diagnostic', JSON.stringify({ source: d.source, code: d.code, message: d.message }));
      }
    }
    if (diags.some((d) => d.message.includes(MARK))) {
      ok = true;
      break;
    }
    if (!tsExtLogged) {
      const ts = vscode.extensions.getExtension('vscode.typescript-language-features');
      log('ts extension active =', ts && ts.isActive);
      if (ts && ts.isActive) tsExtLogged = true;
    }
    await sleep(1000);
  }
  log(
    'elapsed ms',
    Date.now() - start,
    'all diagnostics',
    JSON.stringify(vscode.languages.getDiagnostics(uri).map((d) => d.message)),
  );

  // Hover: proves quickinfo decoration (and that the TS server answers at all).
  let hoverText = '';
  for (let i = 0; i < 20; i++) {
    const hovers = await vscode.commands.executeCommand(
      'vscode.executeHoverProvider',
      uri,
      new vscode.Position(0, 6),
    );
    hoverText = (hovers || [])
      .map((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value)).join('\n'))
      .join('\n---\n');
    if (hoverText) break;
    await sleep(1000);
  }
  log('hover at answer:', JSON.stringify(hoverText));

  log(
    'RESULT',
    ok ? 'PLUGIN_EFFECT_OBSERVED' : 'PLUGIN_EFFECT_NOT_OBSERVED',
    'hoverHasMarker=' + hoverText.includes(MARK),
  );
  if (!ok && !hoverText.includes(MARK)) throw new Error('plugin effect not observed');
};
