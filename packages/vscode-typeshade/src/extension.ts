// === The VS Code extension entry point ===
//
// What this extension is for is decided in `docs/design.md` §4: it activates the TypeScript
// server plugin, which is what carries diagnostics, hover, completions and navigation, and it
// adds only what tsserver cannot carry (the WGSL and GLSL preview, the commands, the debug
// adapter). This file is the skeleton those pieces are added to.

import type * as vscode from 'vscode';

/**
 * Called by the extension host the first time one of the extension's activation events fires.
 *
 * @param context - the extension context, which owns the disposables the extension registers.
 */
export function activate(context: vscode.ExtensionContext): void {
  void context;
}

/** Called by the extension host on shutdown. Every disposable is owned by the context's
 *  subscriptions, so there is nothing to tear down by hand. */
export function deactivate(): void {}
