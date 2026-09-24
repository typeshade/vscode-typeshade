import { describe, expect, it } from 'vitest';
import { escapeHtml, panelHtml } from './html.js';
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

describe('escaping', () => {
  it('covers the five characters that matter in text and in an attribute', () => {
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });

  it('escapes the ampersand first, so an escape is not escaped twice', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});
