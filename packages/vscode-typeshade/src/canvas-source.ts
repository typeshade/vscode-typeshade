// === The Canvas tab's files, read from the editor and the disk ===
//
// `canvas.ts` decides what to compile and builds the message; this is the part that needs VS
// Code: which folder the active file is in, its `typeshade.json`, and the text of every file of
// the graph, an open editor's before the disk's, as `bridge.ts` reads them for the Playground.

import * as vscode from 'vscode';
import { textOf } from './bridge.js';
import { buildCanvas, canvasWorkspace, type CanvasFile } from './canvas.js';
import type { CanvasMessage } from './canvas-plan.js';
import { readManifest, type Manifest } from './workspace-link.js';

/**
 * The message the Canvas draws the active file's workspace from.
 *
 * With a `typeshade.json` at the root of the file's workspace folder that names the file (as its
 * main file or one of its passes), the graph is the manifest's; otherwise the file alone. It
 * never throws: a file that cannot be read, or a manifest that cannot be understood, is a
 * `canvas-error` with the sentence that says so.
 *
 * @param active - the active shader.
 * @param readDocument - the reader of a shader file an import names.
 */
export async function canvasMessageFor(
  active: vscode.Uri,
  readDocument: (uri: string) => string | undefined,
): Promise<CanvasMessage> {
  try {
    const folder = vscode.workspace.getWorkspaceFolder(active)?.uri;
    const base = folder ?? vscode.Uri.joinPath(active, '..');
    const relative = folder === undefined ? active.path.split('/').pop()! : rel(folder, active);
    let manifest: Manifest | undefined;
    if (folder !== undefined) {
      const text = await textOf(vscode.Uri.joinPath(folder, 'typeshade.json'));
      if (text !== undefined) {
        try {
          manifest = readManifest(text);
        } catch (error) {
          return {
            type: 'canvas-error',
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }
    const workspace = canvasWorkspace(relative, manifest);
    const read = async (path: string): Promise<CanvasFile | string> => {
      const uri = vscode.Uri.joinPath(base, path);
      const text = await textOf(uri);
      return text === undefined ? `${path} cannot be read` : { uri: uri.toString(), text };
    };
    const main = await read(workspace.main);
    if (typeof main === 'string') return { type: 'canvas-error', message: main };
    const passes: (CanvasFile & { name: string })[] = [];
    for (const pass of workspace.passes) {
      const file = await read(pass.file);
      if (typeof file === 'string')
        return { type: 'canvas-error', message: `the pass ${pass.name}: ${file}` };
      passes.push({ ...file, name: pass.name });
    }
    return buildCanvas({ main, passes, readDocument });
  } catch (error) {
    return {
      type: 'canvas-error',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** A file's path below a folder, in the `/` form a manifest writes. */
function rel(folder: vscode.Uri, file: vscode.Uri): string {
  return file.path.startsWith(`${folder.path}/`)
    ? file.path.slice(folder.path.length + 1)
    : file.path;
}
