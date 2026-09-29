// === The Playground bridge: a workspace between the site and a folder ===
//
// `docs/playground-bridge.md` §2. Three ways in, all through `workspace-link.ts`, which does the
// formats and has the tests:
//
//   TypeShade: Open in Playground     the active shader's workspace, as a link the browser opens
//   TypeShade: Open Playground Link   a link pasted in, written to a folder that then opens
//   vscode://typeshade.vscode-typeshade/open?link=...
//                                     the same, from the site's "Open in VS Code" (§2.2)

import * as vscode from 'vscode';
import {
  folderOf,
  planLink,
  readLink,
  readManifest,
  shortLinkTarget,
  writeLink,
  type Pass,
  type Workspace,
} from './workspace-link.js';

/** A relative import of another shader file, the only kind the Playground can hold. */
const RELATIVE_IMPORT = /\bfrom\s*(['"])(\.{1,2}\/[^'"]+\.shade\.ts)\1/g;

/** Registers the two commands and the uri handler. */
export function registerBridge(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('typeshade.openInPlayground', openInPlayground),
    vscode.commands.registerCommand('typeshade.openPlaygroundLink', async () => {
      const link = await vscode.window.showInputBox({
        title: 'TypeShade: open a Playground link',
        prompt: 'A link from the Playground: its Copy link, or the page address',
        placeHolder: 'https://typeshade.dev/s/...',
        ignoreFocusOut: true,
      });
      if (link !== undefined && link.trim() !== '') await openLink(link.trim());
    }),
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        if (uri.path !== '/open') return;
        const link = new URLSearchParams(uri.query).get('link');
        if (link !== null && link !== '') await openLink(link);
      },
    }),
  );
}

/** The text of a file: an open editor's, unsaved edits included, else the one on disk. */
async function textOf(uri: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open !== undefined) return open.getText();
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

/** `TypeShade: Open in Playground`. */
async function openInPlayground(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) return;
  try {
    const workspace = await workspaceOf(editor.document.uri);
    await vscode.env.openExternal(vscode.Uri.parse(writeLink(workspace), true));
  } catch (error) {
    void vscode.window.showErrorMessage(
      `TypeShade: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The workspace the active file belongs to.
 *
 * With a `typeshade.json` at the root of the file's workspace folder, it names the main file and
 * the passes; without one, the active file is the main file and there are no passes. Either way
 * the files beside the main one are the ones it and the passes import, followed through their own
 * relative imports: exactly what the Playground needs to compile the same program, and nothing
 * from the rest of the folder.
 */
async function workspaceOf(active: vscode.Uri): Promise<Workspace> {
  const folder = vscode.workspace.getWorkspaceFolder(active)?.uri;
  let mainUri = active;
  let passes: readonly Pass[] = [];
  if (folder !== undefined) {
    const manifestText = await textOf(vscode.Uri.joinPath(folder, 'typeshade.json'));
    if (manifestText !== undefined) {
      const manifest = readManifest(manifestText);
      mainUri = vscode.Uri.joinPath(folder, manifest.main);
      passes = manifest.passes;
    }
  }
  const base = vscode.Uri.joinPath(mainUri, '..');
  const mainText = await textOf(mainUri);
  if (mainText === undefined) throw new Error(`the main file ${mainUri.fsPath} cannot be read`);

  const files: Record<string, string> = {};
  const relative = (uri: vscode.Uri): string => {
    const path = uri.path.slice(base.path.length + 1);
    if (!uri.path.startsWith(`${base.path}/`))
      throw new Error(
        `${uri.fsPath} is above the main file's directory, so the Playground cannot hold it`,
      );
    return path;
  };
  const visit = async (from: vscode.Uri, text: string): Promise<void> => {
    for (const match of text.matchAll(RELATIVE_IMPORT)) {
      const target = vscode.Uri.joinPath(from, '..', match[2]!);
      if (target.toString() === mainUri.toString()) continue;
      const path = relative(target);
      if (files[path] !== undefined) continue;
      const imported = await textOf(target);
      if (imported === undefined) throw new Error(`${target.fsPath} cannot be read`);
      files[path] = imported;
      await visit(target, imported);
    }
  };
  // Pass paths in typeshade.json are relative to the folder; in the link they are relative to
  // the main file's directory, which is the same place when the main file is at the root.
  const linkPasses: Pass[] = [];
  for (const pass of passes) {
    const uri = vscode.Uri.joinPath(folder ?? base, pass.file);
    const text = await textOf(uri);
    if (text === undefined)
      throw new Error(`the pass ${pass.name}'s file ${pass.file} cannot be read`);
    const path = relative(uri);
    files[path] = text;
    linkPasses.push({ name: pass.name, file: path });
    await visit(uri, text);
  }
  await visit(mainUri, mainText);
  return { main: { path: relative(mainUri), text: mainText }, files, passes: linkPasses };
}

/** The Playground link a link stands for. Only the site's own short links are fetched, and only
 *  to read where they redirect; `workspace-link.ts` decides and has the tests. */
async function resolveLink(link: string): Promise<string> {
  const plan = planLink(link);
  if (plan.kind === 'fragment') return plan.link;
  const response = await fetch(plan.url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  return shortLinkTarget(plan.url, response.status, response.headers.get('location'));
}

/** Writes the workspace a link carries to a folder the reader picks, then opens it. */
async function openLink(link: string): Promise<void> {
  try {
    const contents = readLink(await resolveLink(link));
    if (contents.kind !== 'workspace') {
      void vscode.window.showWarningMessage(
        contents.kind === 'example'
          ? `TypeShade: the link opens the example ${contents.id} as it ships, and carries no file. Open it in the Playground and use its download button beside +.`
          : 'TypeShade: the link opens a blank file, and carries no file.',
      );
      return;
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Write the workspace here',
      title: 'TypeShade: an empty folder for the Playground workspace',
    });
    const target = picked?.[0];
    if (target === undefined) return;
    const folder = folderOf(contents.workspace);
    for (const path of Object.keys(folder)) {
      const exists = await vscode.workspace.fs.stat(vscode.Uri.joinPath(target, path)).then(
        () => true,
        () => false,
      );
      if (exists) throw new Error(`${path} already exists in that folder, and nothing was written`);
    }
    const encoder = new TextEncoder();
    for (const [path, text] of Object.entries(folder))
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(target, path), encoder.encode(text));
    await vscode.commands.executeCommand('vscode.openFolder', target, { forceNewWindow: true });
  } catch (error) {
    void vscode.window.showErrorMessage(
      `TypeShade: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
