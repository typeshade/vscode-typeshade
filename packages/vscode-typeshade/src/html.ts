// === The preview panel's document ===
//
// A webview is a full browser context, so the shader text the compiler produced arrives here as
// untrusted input: a `//` comment carrying `</script>` is the whole attack, and it is something
// a user can type into their own file by accident. Every value is escaped and the content
// security policy allows nothing but this document's own nonce'd style and script.
//
// No `vscode` import, so §6's unit tests can assert the escaping rather than trusting it.

import { PREVIEW_TABS, type PreviewOutput, type PreviewTab } from './model.js'

/** What the panel needs to render itself. */
export interface PanelState {
  /** The file name shown in the header, already short. */
  readonly fileName: string
  /** Which tab is selected. */
  readonly active: PreviewTab
  /** The selected tab's output, or undefined when the model holds nothing for this file. */
  readonly output: PreviewOutput | undefined
}

/** The label each tab shows. */
const TAB_LABELS: Readonly<Record<PreviewTab, string>> = {
  wgsl: 'WGSL',
  'glsl-vertex': 'GLSL vertex',
  'glsl-fragment': 'GLSL fragment',
  reflection: 'Reflection',
}

/**
 * The panel's whole document.
 *
 * @param state - what to show.
 * @param nonce - the one value the content security policy admits, fresh per render.
 * @returns the HTML.
 */
export function panelHtml(state: PanelState, nonce: string): string {
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ')
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<title>TypeShade preview</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<header>
  <span class="file">${escapeHtml(state.fileName)}</span>
  <nav>${tabs(state.active)}</nav>
</header>
${banner(state.output)}
<pre class="${state.output?.stale === true ? 'output stale' : 'output'}">${escapeHtml(bodyText(state.output))}</pre>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`
}

/** The tab strip, with the selected one marked for the stylesheet and for a screen reader. */
function tabs(active: PreviewTab): string {
  return PREVIEW_TABS.map((tab) => {
    const selected = tab === active
    return `<button type="button" class="tab${selected ? ' selected' : ''}" data-tab="${tab}" aria-pressed="${selected}">${escapeHtml(TAB_LABELS[tab])}</button>`
  }).join('')
}

/** The one line above the text, which is the only place the panel mentions a diagnostic.
 *
 *  §4 keeps the diagnostics themselves in the Problems view, because a second copy of them is a
 *  second place to be stale. What is left here is the fact that the text below is older than the
 *  file, which the Problems view cannot say. */
function banner(output: PreviewOutput | undefined): string {
  if (output === undefined) return ''
  if (output.stale) {
    return `<p class="banner">Showing the last output that compiled. The file has ${count(output.diagnostics.length, 'error')} right now.</p>`
  }
  if (output.text === '') {
    return `<p class="banner">Nothing to show: this file compiles to no ${output.tab === 'reflection' ? 'reflection' : 'shader code'}.</p>`
  }
  return ''
}

/** The text the panel shows, which is empty rather than absent when there is nothing. */
function bodyText(output: PreviewOutput | undefined): string {
  return output?.text ?? ''
}

/** `1 error` or `2 errors`, because the banner reads as a sentence. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

/**
 * Escapes text for an HTML text node or a double-quoted attribute.
 *
 * @param text - the text to escape.
 * @returns the escaped text.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** The panel's stylesheet. Every colour is one of VS Code's own theme variables, so the panel
 *  follows the user's theme rather than picking colours of its own. */
const STYLE = `
  body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  header { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
           padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--vscode-panel-border); }
  .file { font-weight: 600; }
  nav { display: flex; gap: 0.25rem; }
  .tab { background: transparent; color: var(--vscode-foreground); border: 1px solid transparent;
         border-radius: 3px; padding: 0.2rem 0.6rem; cursor: pointer; font: inherit; }
  .tab:hover { background: var(--vscode-toolbar-hoverBackground); }
  .tab.selected { border-color: var(--vscode-focusBorder);
                  background: var(--vscode-editor-inactiveSelectionBackground); }
  .banner { margin: 0; padding: 0.4rem 0.75rem;
            background: var(--vscode-inputValidation-warningBackground);
            border-bottom: 1px solid var(--vscode-inputValidation-warningBorder); }
  .output { margin: 0; padding: 0.75rem; white-space: pre; overflow: auto;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size); }
  .output.stale { opacity: 0.5; }
`

/** The panel's script: the tab strip, and nothing else. The panel is read-only (§4), so this is
 *  the only thing it can do. */
const SCRIPT = `
  const vscode = acquireVsCodeApi();
  for (const button of document.querySelectorAll('.tab')) {
    button.addEventListener('click', () => {
      vscode.postMessage({ type: 'selectTab', tab: button.dataset.tab });
    });
  }
`
