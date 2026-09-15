// === The preview panel ===
//
// One `WebviewPanel` for the whole window, not one per file (`docs/design.md` §4): it opens
// beside the editor, follows the active editor, and updates on edit behind a debounce. Two
// panels would mean two answers to "what am I looking at".
//
// Everything decided here is about VS Code. What to SHOW is `model.ts`, and what the document
// looks like is `html.ts`, neither of which imports `vscode`.

import * as vscode from 'vscode'
import { panelHtml } from './html.js'
import type { PreviewModel, PreviewTab } from './model.js'

/** The view type the panel is registered under, and the key its state is restored with. */
export const VIEW_TYPE = 'typeshade.preview'

/** What the panel reads out of the extension's settings on every render. */
export interface PreviewSettings {
  /** `typeshade.preview.autoUpdate`. */
  readonly autoUpdate: boolean
  /** `typeshade.preview.debounceMs`. */
  readonly debounceMs: number
}

/**
 * The window's single preview panel.
 *
 * Created lazily by the first command that shows it, and disposed with the extension.
 */
export class PreviewPanel {
  private panel: vscode.WebviewPanel | undefined
  private uri: string | undefined
  private tab: PreviewTab = 'wgsl'
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly model: PreviewModel,
    private readonly settings: () => PreviewSettings,
  ) {}

  /**
   * Opens the panel on `tab` for `document`, or moves an open one to them.
   *
   * @param document - the shader to show.
   * @param tab - which tab to select.
   */
  show(document: vscode.TextDocument, tab: PreviewTab): void {
    this.tab = tab
    this.uri = document.uri.toString()
    this.ensure().reveal(vscode.ViewColumn.Beside, true)
    this.render()
  }

  /**
   * Follows the editor, if a panel is open and the file is one the model holds.
   *
   * @param document - the document that just became active, or undefined when none did.
   */
  follow(document: vscode.TextDocument | undefined): void {
    if (this.panel === undefined || document === undefined) return
    const uri = document.uri.toString()
    if (!this.model.has(uri) || uri === this.uri) return
    this.uri = uri
    this.render()
  }

  /**
   * Re-renders after an edit, behind the configured debounce.
   *
   * @param uri - the document that changed.
   */
  invalidate(uri: string): void {
    if (this.panel === undefined || uri !== this.uri) return
    const { autoUpdate, debounceMs } = this.settings()
    if (!autoUpdate) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.render()
    }, debounceMs)
  }

  /** The text the panel is showing, for `typeshade.copyOutput`. Empty when nothing is. */
  currentText(): string {
    if (this.uri === undefined) return ''
    return this.model.output(this.uri, this.tab)?.text ?? ''
  }

  /** Whether a panel is open at all, which is what `typeshade.copyOutput`'s `when` clause and
   *  its error message both need to know. */
  isOpen(): boolean {
    return this.panel !== undefined
  }

  /** Closes the panel and cancels a pending render. */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.panel?.dispose()
    this.panel = undefined
  }

  /** The panel, created on first use. */
  private ensure(): vscode.WebviewPanel {
    if (this.panel !== undefined) return this.panel
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'TypeShade preview',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      // No `localResourceRoots`: the document is self-contained, so the webview needs to load
      // nothing at all, and the content security policy in `html.ts` says so.
      { enableScripts: true, retainContextWhenHidden: true },
    )
    panel.onDidDispose(() => {
      this.panel = undefined
      if (this.timer !== undefined) clearTimeout(this.timer)
      this.timer = undefined
    })
    panel.webview.onDidReceiveMessage((message: { type?: string; tab?: PreviewTab }) => {
      if (message.type !== 'selectTab' || message.tab === undefined) return
      this.tab = message.tab
      this.render()
    })
    this.panel = panel
    return panel
  }

  /** Writes the current state into the webview. */
  private render(): void {
    if (this.panel === undefined || this.uri === undefined) return
    const parsed = vscode.Uri.parse(this.uri)
    this.panel.webview.html = panelHtml(
      {
        fileName: parsed.path.split('/').pop() ?? this.uri,
        active: this.tab,
        output: this.model.output(this.uri, this.tab),
      },
      nonce(),
    )
  }
}

/** A fresh nonce per render. `Math.random` is not a security primitive, and this does not need
 *  one: the nonce stops a script the panel's own HTML did not carry, and that HTML is written
 *  here, in this process, immediately before it is used. */
function nonce(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}
