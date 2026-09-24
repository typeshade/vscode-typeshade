// === The VS Code extension entry point ===
//
// What this extension is for is decided in `docs/design.md` §4: it activates the TypeScript
// server plugin, which is what carries diagnostics, hover, completions and navigation, and it
// adds only what tsserver cannot carry. This file is the wiring; everything it wires up that can
// be tested without an extension host lives in a module that does not import `vscode`.

import * as vscode from 'vscode';
import { compileModule, isTypeshadeSource, type CpuValue } from './compiler.js';
import { describe, parseInvocation } from './invocation.js';
import { PreviewModel, type Entry, type PreviewTab } from './model.js';
import { PreviewPanel, type PreviewSettings } from './panel.js';

/** The plugin's package name, which is both what `contributes.typescriptServerPlugins` names and
 *  what `configurePlugin` addresses. */
const PLUGIN_ID = '@typeshade/tsserver-plugin';

/** The context key every command's `when` clause reads. Set from the extension's own service, so
 *  it agrees with the plugin about what a shader is: both ask the compiler. */
const IS_SHADER = 'typeshade.isShader';

/**
 * Called by the extension host the first time one of the extension's activation events fires.
 *
 * @param context - the extension context, which owns the disposables the extension registers.
 */
export function activate(context: vscode.ExtensionContext): void {
  const model = new PreviewModel({
    // An import between shaders resolves against the documents the editor already has open,
    // which is every file the panel can be showing. A file that is not open is left unresolved
    // rather than read from disk: the extension host's service exists to render what the user is
    // looking at, and reading the workspace would make it a second project system.
    readDocument: (uri) =>
      vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri)?.getText(),
  });
  const panel = new PreviewPanel(model, settings);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'typeshade.showWgsl';

  context.subscriptions.push(panel, status, {
    dispose: () => {
      for (const document of vscode.workspace.textDocuments) {
        model.closeDocument(document.uri.toString());
      }
    },
  });

  const sync = (document: vscode.TextDocument): boolean => {
    const uri = document.uri.toString();
    if (document.languageId !== 'typescript' && document.languageId !== 'typescriptreact') {
      return false;
    }
    if (!isTypeshadeSource(document.getText(), uri)) {
      model.closeDocument(uri);
      return false;
    }
    model.setDocument(uri, document.getText(), document.version);
    return true;
  };

  const refresh = (): void => {
    const editor = vscode.window.activeTextEditor;
    const isShader = editor !== undefined && sync(editor.document);
    void vscode.commands.executeCommand('setContext', IS_SHADER, isShader);
    updateStatus(status, model, editor, isShader);
    panel.follow(editor?.document);
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(refresh),
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidCloseTextDocument((document) => {
      model.closeDocument(document.uri.toString());
      refresh();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document !== vscode.window.activeTextEditor?.document) return;
      refresh();
      panel.invalidate(event.document.uri.toString());
    }),
    vscode.languages.onDidChangeDiagnostics(() => {
      const editor = vscode.window.activeTextEditor;
      updateStatus(
        status,
        model,
        editor,
        editor !== undefined && model.has(editor.document.uri.toString()),
      );
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('typeshade.diagnostics.replace')) void configurePlugin();
    }),
  );

  for (const [command, tab] of [
    ['typeshade.showWgsl', 'wgsl'],
    ['typeshade.showGlsl', 'glsl-vertex'],
    ['typeshade.showReflection', 'reflection'],
  ] as const) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, () => {
        const editor = vscode.window.activeTextEditor;
        if (editor === undefined || !sync(editor.document)) {
          void vscode.window.showWarningMessage('TypeShade: the active file is not a shader.');
          return;
        }
        panel.show(editor.document, tab satisfies PreviewTab);
      }),
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('typeshade.copyOutput', async () => {
      const text = panel.currentText();
      if (text === '') {
        void vscode.window.showWarningMessage('TypeShade: the preview has nothing to copy.');
        return;
      }
      await vscode.env.clipboard.writeText(text);
    }),
    vscode.commands.registerCommand('typeshade.runEntry', () => runEntry(model)),
  );

  void configurePlugin();
  refresh();
}

/** Called by the extension host on shutdown. Every disposable is owned by the context's
 *  subscriptions, so there is nothing to tear down by hand. */
export function deactivate(): void {}

/** The panel's settings, read fresh on every use so a change takes effect without a reload. */
function settings(): PreviewSettings {
  const config = vscode.workspace.getConfiguration('typeshade');
  return {
    autoUpdate: config.get<boolean>('preview.autoUpdate', true),
    debounceMs: config.get<number>('preview.debounceMs', 300),
  };
}

/**
 * Sends `typeshade.diagnostics.replace` to the plugin.
 *
 * `configurePlugin` is the only supported channel from an extension to a tsserver plugin, and it
 * is one-way (`docs/design.md` §4). Nothing here can read the plugin's state back, so a failure
 * is logged as a warning rather than retried.
 */
async function configurePlugin(): Promise<void> {
  const typescript = vscode.extensions.getExtension<{
    configurePlugin?(id: string, configuration: unknown): void;
  }>('vscode.typescript-language-features');
  if (typescript === undefined) return;
  const api = typescript.isActive ? typescript.exports : await typescript.activate();
  api?.configurePlugin?.(PLUGIN_ID, {
    replaceDiagnostics: vscode.workspace
      .getConfiguration('typeshade')
      .get<boolean>('diagnostics.replace', true),
  });
}

/**
 * Shows what the active file is, and whether the plugin is doing its job.
 *
 * The second half is the one §4 asks for by name: if this extension's own service parses the
 * file as a shader and the Problems view still carries TypeScript's own diagnostics on it, the
 * plugin did not load, and the item says so rather than leaving the user to guess. The check is
 * cheap and it is the only signal available, because nothing can ask tsserver whether a plugin
 * loaded.
 */
function updateStatus(
  status: vscode.StatusBarItem,
  model: PreviewModel,
  editor: vscode.TextEditor | undefined,
  isShader: boolean,
): void {
  if (editor === undefined || !isShader) {
    status.hide();
    return;
  }
  const entries = model.entries(editor.document.uri.toString());
  const unreplaced = vscode.languages
    .getDiagnostics(editor.document.uri)
    .filter((diagnostic) => diagnostic.source === 'ts');
  if (unreplaced.length > 0) {
    status.text = '$(warning) TypeShade: plugin not active';
    status.tooltip =
      'This file is a shader, but TypeScript is still reporting its own errors on it, which means the TypeShade server plugin did not load. Check that the workspace TypeScript version is being used.';
  } else {
    const count = entries.length;
    status.text = `TypeShade: ${count} ${count === 1 ? 'entry' : 'entries'}`;
    status.tooltip = entries.map((entry) => `${entry.stage} ${entry.name}`).join('\n');
  }
  status.show();
}

/**
 * `TypeShade: Run Entry on CPU`.
 *
 * Picks an entry, asks for the invocation, runs it on the CPU oracle, shows what came back.
 * Every step can end the command, and each says why.
 *
 * @param model - the extension's own view of the open shaders.
 */
async function runEntry(model: PreviewModel): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const uri = editor?.document.uri.toString();
  if (uri === undefined || !model.has(uri)) {
    void vscode.window.showWarningMessage('TypeShade: the active file is not a shader.');
    return;
  }
  const module = model.module(uri);
  const entries = model.entries(uri);
  if (module === undefined || entries.length === 0) {
    void vscode.window.showWarningMessage(
      'TypeShade: this file has no entry point that compiles right now.',
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    entries.map((entry) => ({ label: entry.name, description: entry.stage, entry })),
    { title: 'TypeShade: run an entry on the CPU' },
  );
  if (picked === undefined) return;
  const entry: Entry = picked.entry;

  const typed = await vscode.window.showInputBox({
    title: `Run ${entry.name} on the CPU`,
    prompt: `Arguments for ${entry.name}(${describe(entry.params)})`,
    placeHolder: entry.params.length === 0 ? 'no arguments' : '1, [0.5, 0.5, 0, 1]',
    validateInput: (value) => {
      const parsed = parseInvocation(value, entry.params);
      return parsed.ok ? undefined : parsed.error;
    },
  });
  if (typed === undefined) return;
  const parsed = parseInvocation(typed, entry.params);
  if (!parsed.ok) {
    void vscode.window.showErrorMessage(`TypeShade: ${parsed.error}`);
    return;
  }

  try {
    const precision = vscode.workspace
      .getConfiguration('typeshade')
      .get<'f32' | 'f64'>('debug.precision', 'f32');
    const compiled = compileModule(module, { precision });
    const fn = compiled.fns[entry.name];
    if (fn === undefined) {
      void vscode.window.showErrorMessage(
        `TypeShade: ${entry.name} is not in the compiled module.`,
      );
      return;
    }
    const returned = fn(...(parsed.values as CpuValue[]));
    void vscode.window.showInformationMessage(
      `${entry.name}(${parsed.values.map((value) => JSON.stringify(value)).join(', ')}) = ${JSON.stringify(returned)}`,
    );
  } catch (error) {
    // The oracle throws for a shader that reads a binding nothing set, or an intrinsic it stubs.
    // That is a fact about this shader and this invocation, not a bug in the extension, so it is
    // reported rather than swallowed into the log.
    void vscode.window.showErrorMessage(
      `TypeShade: ${entry.name} threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
