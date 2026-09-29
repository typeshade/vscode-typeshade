// === The extension in VS Code for the Web ===
//
// The web extension host loads the manifest's `browser` file, and this is it. It carries almost
// nothing on purpose. What the web gives a shader author (diagnostics, hover, completion,
// navigation) comes from the TypeScript server plugin, which the host loads on its own from the
// plugin package's `browser` field, so nothing here has to run for those to work. The preview,
// the Canvas, Run Entry on CPU and the Playground link read the disk and compress with node
// modules the browser has not, and are not ported (`docs/playground-bridge.md` §4).
//
// So every command the manifest contributes is registered as a stub that says what the web has
// and what needs the desktop, because a command that is contributed and not registered fails with
// "command not found", and the editor title menu and a key binding reach it even when the palette
// hides it. On activation the entry also warns once when the page cannot run the plugin
// (`describeEnvironment`). It never touches `process`, `Buffer` or `require`; `eslint.config.mjs`
// refuses a Node import in this file, since `tsc` here has Node's types and would not.

import * as vscode from 'vscode';
import {
  describeEnvironment,
  hostSupportsWebPlugin,
  webCommandIds,
  WEB_STUB_MESSAGE,
  type TypeshadeWebApi,
} from './web-support.js';

/**
 * Called by the web extension host the first time one of the extension's activation events fires.
 *
 * @param context - the extension context, which owns the disposables the extension registers.
 * @returns what the entry found out about the page, for the web suite to compare with its own.
 */
export function activate(context: vscode.ExtensionContext): TypeshadeWebApi {
  for (const command of webCommandIds(context.extension.packageJSON)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => {
        // Not awaited: `executeCommand` resolves with the handler, and a message resolves when
        // the user closes it, so an awaited message would hold every caller until then.
        void vscode.window.showInformationMessage(WEB_STUB_MESSAGE);
      }),
    );
  }

  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  const notice = describeEnvironment({ isolated, version: vscode.version });
  if (notice !== undefined) void vscode.window.showWarningMessage(notice);

  return { web: { isolated, supported: hostSupportsWebPlugin(vscode.version), notice } };
}
