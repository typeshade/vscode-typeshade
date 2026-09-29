import { describe, expect, it } from 'vitest';
import { canvasHtml, escapeHtml, panelHtml } from './html.js';
import { PREVIEW_TABS, type PreviewOutput } from './model.js';

function output(over: Partial<PreviewOutput> = {}): PreviewOutput {
  return { tab: 'wgsl', text: 'fn main() {}', stale: false, diagnostics: [], ...over };
}

describe('the panel document', () => {
  it('shows every tab, with the selected one marked', () => {
    const html = panelHtml(
      { fileName: 'hello.shade.ts', active: 'glsl-vertex', output: output() },
      'n1',
    );
    for (const tab of PREVIEW_TABS) expect(html).toContain(`data-tab="${tab}"`);
    expect(html).toContain('data-tab="glsl-vertex" aria-pressed="true"');
    expect(html).toContain('data-tab="wgsl" aria-pressed="false"');
  });

  it('escapes the compiled text, which is the one place a shader can reach the DOM', () => {
    // Not hypothetical: a `//` comment carrying this is something a user can type into their own
    // file, and the compiler passes comments through into the emitted source.
    const html = panelHtml(
      {
        fileName: 'x.shade.ts',
        active: 'wgsl',
        output: output({ text: '// </script><img src=x>' }),
      },
      'n1',
    );
    expect(html).not.toContain('</script><img');
    expect(html).toContain('&lt;/script&gt;&lt;img src=x&gt;');
  });

  it('escapes the file name too', () => {
    const html = panelHtml({ fileName: '<b>.shade.ts', active: 'wgsl', output: output() }, 'n1');
    expect(html).toContain('&lt;b&gt;.shade.ts');
    expect(html).not.toContain('<b>.shade.ts');
  });

  it('admits only the nonce it was given', () => {
    const html = panelHtml({ fileName: 'a.ts', active: 'wgsl', output: output() }, 'abc123');
    expect(html).toContain('default-src &#39;none&#39;');
    expect(html).toContain('script-src &#39;nonce-abc123&#39;');
    expect(html).toContain('<script nonce="abc123">');
    // No `unsafe-inline` anywhere: a policy that allows it makes the nonce decorative.
    expect(html).not.toContain('unsafe-inline');
  });

  it('says the text is old rather than showing nothing', () => {
    const html = panelHtml(
      {
        fileName: 'a.ts',
        active: 'wgsl',
        output: output({ stale: true, diagnostics: [{ severity: 'error' }] as never[] }),
      },
      'n1',
    );
    expect(html).toContain('class="output stale"');
    expect(html).toContain('Showing the last output that compiled');
    expect(html).toContain('1 error right now');
  });

  it('says nothing to show, rather than showing an empty box with no explanation', () => {
    const html = panelHtml(
      { fileName: 'a.ts', active: 'glsl-vertex', output: output({ text: '' }) },
      'n1',
    );
    expect(html).toContain('compiles to no shader code');
  });

  it('renders with no output at all', () => {
    const html = panelHtml({ fileName: 'a.ts', active: 'wgsl', output: undefined }, 'n1');
    expect(html).toContain('<pre class="output"></pre>');
  });
});

describe('the Canvas document', () => {
  const canvas = (nonce = 'n1', script = 'vscode-resource://x/dist/webview/canvas.js'): string =>
    canvasHtml({ fileName: 'hello.shade.ts', active: 'canvas', output: undefined }, nonce, script);

  it('is the text tabs, then a fifth, with the canvas selected', () => {
    const html = canvas();
    for (const tab of PREVIEW_TABS) expect(html).toContain(`data-tab="${tab}"`);
    expect(PREVIEW_TABS).toEqual(['wgsl', 'glsl-vertex', 'glsl-fragment', 'reflection', 'canvas']);
    expect(html).toContain('data-tab="canvas" aria-pressed="true"');
    expect(html).toContain('>Canvas</button>');
    expect(html).toContain('<canvas id="canvas"');
  });

  it("loads the extension's bundle by the URI it was given, and admits it by nonce", () => {
    const html = canvas('abc123');
    expect(html).toContain(
      '<script nonce="abc123" src="vscode-resource://x/dist/webview/canvas.js"></script>',
    );
    // The policy is the text tabs' policy: nothing is added for the script, and nothing else is
    // allowed, so the canvas loads no image, no font, no frame and makes no request of its own.
    expect(html).toContain(
      'default-src &#39;none&#39;; style-src &#39;nonce-abc123&#39;; script-src &#39;nonce-abc123&#39;',
    );
    expect(html).not.toContain('unsafe-inline');
    expect(html).not.toContain('unsafe-eval');
    expect(html).not.toMatch(/(connect|img|frame|font|worker)-src/);
  });

  it('carries no inline script, since the bundle wires the tab strip itself', () => {
    // A second `acquireVsCodeApi()` in one webview throws, so the tab strip's script cannot be
    // here as well.
    expect(canvas()).not.toMatch(/<script nonce="[^"]*">/);
  });

  it('escapes the file name and the script URI', () => {
    const html = canvasHtml(
      { fileName: '<b>.shade.ts', active: 'canvas', output: undefined },
      'n1',
      'x" onload="alert(1)',
    );
    expect(html).toContain('&lt;b&gt;.shade.ts');
    expect(html).not.toContain('<b>.shade.ts');
    expect(html).toContain('src="x&quot; onload=&quot;alert(1)"');
  });

  it('starts with the banners hidden, which the script fills with text and never with HTML', () => {
    const html = canvas();
    expect(html).toContain('id="banner" hidden');
    expect(html).toContain('id="note" hidden');
  });
});

describe('escaping', () => {
  it('covers the five characters that matter in text and in an attribute', () => {
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });

  it('escapes the ampersand first, so an escape is not escaped twice', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});
