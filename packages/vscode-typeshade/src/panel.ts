// === The preview panel ===
//
// One `WebviewPanel` for the whole window, not one per file (`docs/design.md` §4): it opens
// beside the editor, follows the active editor, and updates on edit behind a debounce. Two
// panels would mean two answers to "what am I looking at".
//
// Everything decided here is about VS Code. What to SHOW is `model.ts`, and what the document
// looks like is `html.ts`, neither of which imports `vscode`.

import * as vscode from 'vscode';
import { canvasMessageFor } from './canvas-source.js';
import type { CanvasMessage, CanvasStatus, WebviewMessage } from './canvas-plan.js';
import { canvasHtml, panelHtml } from './html.js';
import type { PreviewModel, PreviewTab } from './model.js';

/** The view type the panel is registered under, and the key its state is restored with. */
export const VIEW_TYPE = 'typeshade.preview';

/** What the panel reads out of the extension's settings on every render. */
export interface PreviewSettings {
  /** `typeshade.preview.autoUpdate`. */
  readonly autoUpdate: boolean;
  /** `typeshade.preview.debounceMs`. */
  readonly debounceMs: number;
}

/**
 * The window's single preview panel.
 *
 * Created lazily by the first command that shows it, and disposed with the extension.
 */
export class PreviewPanel {
  private panel: vscode.WebviewPanel | undefined;
  private uri: string | undefined;
  private tab: PreviewTab = 'wgsl';
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the webview's document is the Canvas one, written once and then only messaged. */
  private canvasDocument = false;
  /** Whether that document's script is listening, which it says with `canvas-ready`. */
  private canvasReady = false;
  /** Bumped by every push, so a slow compile does not land after a newer one. */
  private push = 0;
  /** What the Canvas script last said about itself, for the extension's test hook. */
  private status: CanvasStatus | undefined;

  constructor(
    private readonly model: PreviewModel,
    private readonly settings: () => PreviewSettings,
    private readonly extensionUri: vscode.Uri,
    private readonly readDocument: (uri: string) => string | undefined,
  ) {}

  /**
   * Opens the panel on `tab` for `document`, or moves an open one to them.
   *
   * @param document - the shader to show.
   * @param tab - which tab to select.
   */
  show(document: vscode.TextDocument, tab: PreviewTab): void {
    this.tab = tab;
    this.uri = document.uri.toString();
    this.ensure().reveal(vscode.ViewColumn.Beside, true);
    this.render();
  }

  /**
   * Follows the editor, if a panel is open and the file is one the model holds.
   *
   * @param document - the document that just became active, or undefined when none did.
   */
  follow(document: vscode.TextDocument | undefined): void {
    if (this.panel === undefined || document === undefined) return;
    const uri = document.uri.toString();
    if (!this.model.has(uri) || uri === this.uri) return;
    this.uri = uri;
    this.render();
  }

  /**
   * Re-renders after an edit, behind the configured debounce.
   *
   * @param uri - the document that changed.
   */
  invalidate(uri: string): void {
    if (this.panel === undefined || uri !== this.uri) return;
    const { autoUpdate, debounceMs } = this.settings();
    if (!autoUpdate) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.render();
    }, debounceMs);
  }

  /** The text the panel is showing, for `typeshade.copyOutput`. Empty when nothing is, and for
   *  the Canvas, which shows none. */
  currentText(): string {
    if (this.uri === undefined || this.tab === 'canvas') return '';
    return this.model.output(this.uri, this.tab)?.text ?? '';
  }

  /** Whether a panel is open at all, which is what `typeshade.copyOutput`'s `when` clause and
   *  its error message both need to know. */
  isOpen(): boolean {
    return this.panel !== undefined;
  }

  /** What the Canvas script last reported: no WebGPU, frames drawing, or a failure. Undefined
   *  until it has said anything. `typeshade.showCanvas`'s test reads it (`extension.ts`). */
  canvasStatus(): CanvasStatus | undefined {
    return this.status;
  }

  /** Closes the panel and cancels a pending render. */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.panel?.dispose();
    this.panel = undefined;
  }

  /** The panel, created on first use. */
  private ensure(): vscode.WebviewPanel {
    if (this.panel !== undefined) return this.panel;
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'TypeShade preview',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        // The Canvas needs its GPU device, its loop and the pointer to outlive a hidden tab.
        retainContextWhenHidden: true,
        // The one thing the webview may load is the Canvas bundle, so the only directory it may
        // read is the one that holds it. The text tabs load nothing at all.
        localResourceRoots: [WEBVIEW_ROOT(this.extensionUri)],
      },
    );
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.canvasDocument = false;
      this.canvasReady = false;
      if (this.timer !== undefined) clearTimeout(this.timer);
      this.timer = undefined;
    });
    panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
      switch (message.type) {
        case 'selectTab':
          if (isTab(message.tab)) {
            this.tab = message.tab;
            this.render();
          }
          return;
        case 'canvas-ready':
          this.canvasReady = true;
          void this.pushCanvas();
          return;
        case 'canvas-status':
          this.status = message;
          return;
      }
    });
    this.panel = panel;
    return panel;
  }

  /** Writes the current state into the webview. */
  private render(): void {
    if (this.panel === undefined || this.uri === undefined) return;
    const parsed = vscode.Uri.parse(this.uri);
    const fileName = parsed.path.split('/').pop() ?? this.uri;
    if (this.tab === 'canvas') {
      // The Canvas document is written once, on the switch to the tab, and then only messaged.
      if (!this.canvasDocument) {
        this.canvasDocument = true;
        this.canvasReady = false;
        const script = this.panel.webview.asWebviewUri(
          vscode.Uri.joinPath(WEBVIEW_ROOT(this.extensionUri), 'canvas.js'),
        );
        this.panel.webview.html = canvasHtml(
          { fileName, active: 'canvas', output: undefined },
          nonce(),
          script.toString(),
        );
      } else void this.pushCanvas();
      return;
    }
    this.canvasDocument = false;
    this.canvasReady = false;
    this.panel.webview.html = panelHtml(
      {
        fileName,
        active: this.tab,
        output: this.model.output(this.uri, this.tab),
      },
      nonce(),
    );
  }

  /** Compiles the active file's workspace and posts it to the Canvas script. */
  private async pushCanvas(): Promise<void> {
    if (this.panel === undefined || this.uri === undefined || !this.canvasReady) return;
    const mine = ++this.push;
    const uri = vscode.Uri.parse(this.uri);
    const message: CanvasMessage = {
      ...(await canvasMessageFor(uri, this.readDocument)),
      title: uri.path.split('/').pop() ?? this.uri,
    };
    if (mine !== this.push || this.panel === undefined || !this.canvasReady) return;
    void this.panel.webview.postMessage(message);
  }
}

/** The directory the extension ships the webview bundle in. */
const WEBVIEW_ROOT = (extensionUri: vscode.Uri): vscode.Uri =>
  vscode.Uri.joinPath(extensionUri, 'dist', 'webview');

const TABS: readonly string[] = ['wgsl', 'glsl-vertex', 'glsl-fragment', 'reflection', 'canvas'];

/** A tab id a webview sent, which is untrusted input like everything else it posts. */
const isTab = (tab: string): tab is PreviewTab => TABS.includes(tab);

/** A fresh nonce per render. `Math.random` is not a security primitive, and this does not need
 *  one: the nonce stops a script the panel's own HTML did not carry, and that HTML is written
 *  here, in this process, immediately before it is used. */
function nonce(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
