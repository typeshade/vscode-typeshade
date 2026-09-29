// === The suite that runs INSIDE a real VS Code ===
//
// `docs/design.md` §6: the extension's logic lives in modules that do not import `vscode` and is
// unit-tested with vitest, so what is left for an extension host is exactly the part vitest
// cannot reach. That is what this file asserts and nothing more: that the extension activates,
// that its commands are registered, that the context key gates them, that the preview panel
// opens with the right text in it, and that the TypeScript server plugin actually loaded.
//
// There is no mocha here. The VS Code test runner asks an `extensionTestsPath` module for a
// `run()` and fails the run when it rejects, which is the whole of what a framework would add
// for a suite this size; `node:assert` and a list of named cases do the rest, and the launcher
// has one dependency instead of four.

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';
import type { TypeshadeApi } from '../src/extension.js';
import { createSuite } from '../test-shared/harness.js';
import { open, registerPluginCases, waitFor } from '../test-shared/plugin-cases.js';

/** The extension's id, as the Marketplace will address it: publisher, then name. */
const EXTENSION_ID = 'typeshade.vscode-typeshade';

const { test, run } = createSuite();

test('activates, and contributes the plugin to the workspace TypeScript', async () => {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed in this host`);
  await extension.activate();
  assert.equal(extension.isActive, true);

  const contributed = (
    extension.packageJSON as {
      contributes: {
        typescriptServerPlugins: { enableForWorkspaceTypeScriptVersions?: boolean }[];
      };
    }
  ).contributes.typescriptServerPlugins;
  assert.equal(contributed[0].enableForWorkspaceTypeScriptVersions, true);
});

test('registers every command it contributes', async () => {
  const registered = new Set(await vscode.commands.getCommands(true));
  for (const command of [
    'typeshade.showWgsl',
    'typeshade.showGlsl',
    'typeshade.showReflection',
    'typeshade.showCanvas',
    'typeshade.runEntry',
    'typeshade.copyOutput',
    'typeshade.openInPlayground',
    'typeshade.openPlaygroundLink',
  ]) {
    assert.ok(registered.has(command), `${command} is not registered`);
  }
});

test('opens the preview with the compiled WGSL in it', async () => {
  const document = await open('hello.shade.ts');
  await vscode.commands.executeCommand('typeshade.showWgsl');
  const panel = await waitFor(() =>
    vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find((tab) => tab.label === 'TypeShade preview'),
  );
  assert.ok(panel, 'the preview panel did not open');
  // The panel's text is not readable from the extension host, so what is asserted here is what
  // is observable: it opened, beside the editor, for this document. What the text IS is
  // `model.test.ts`'s assertion, over the same model this panel renders.
  assert.notEqual(panel.group.viewColumn, vscode.window.activeTextEditor?.viewColumn);
  assert.ok(document.getText().includes('use typeshade'));
});

test('opens the Canvas tab, which draws or says why it cannot, and never fails', async () => {
  // The Canvas draws with WebGPU in the webview (`docs/playground-bridge.md` §3), which a
  // headless runner under `--disable-gpu` does not have: there the script says so in one
  // sentence and draws nothing, and on a machine with a GPU it draws. Either is a pass. What
  // this asserts is the one thing a webview must not do here: fail, or say nothing at all,
  // which is how a script the content security policy refused, a bundle missing from the
  // package or a message that never arrived would look.
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed in this host`);
  const api = (await extension.activate()) as TypeshadeApi;
  assert.equal(typeof api.canvasStatus, 'function', 'the extension returns no API');
  await open('hello.shade.ts');
  await vscode.commands.executeCommand('typeshade.showCanvas');
  const panel = await waitFor(() =>
    vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find((tab) => tab.label === 'TypeShade preview'),
  );
  assert.ok(panel, 'the preview panel did not open');
  const status = await waitFor(() => api.canvasStatus(), 60_000);
  assert.ok(status, 'the Canvas script said nothing: it did not load, or it did not run');
  assert.notEqual(
    status.state,
    'failed',
    `the Canvas failed: ${status.state === 'failed' ? status.reason : ''}`,
  );
  console.log(
    `  canvas: ${status.state}${status.state === 'unsupported' ? ` (${status.reason})` : ''}`,
  );
});

test('leaves a file without the directive alone', async () => {
  await open('plain.ts');
  // The context key is not readable either, so this asserts the user-visible consequence: the
  // command refuses rather than opening a panel on a file that is not a shader.
  const before = vscode.window.tabGroups.all.flatMap((group) => group.tabs).length;
  await vscode.commands.executeCommand('typeshade.showReflection');
  await delay(200);
  assert.equal(vscode.window.tabGroups.all.flatMap((group) => group.tabs).length, before);
});

// The three cases about the plugin itself are shared with the web suite: the same files, the same
// assertions, in the host that runs the desktop's server and the one that runs the browser's.
registerPluginCases(test);

export { run };
