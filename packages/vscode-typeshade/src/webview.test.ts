// The Canvas tab's script is the one bundle that runs in a browser, so what it must not carry is
// asserted on the file the build wrote (`npm run build` runs first in `npm run check`). A webview
// that quietly grew the whole compiler would still draw, and would ship 11 MB more.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BUNDLE = fileURLToPath(new URL('../dist/webview/canvas.js', import.meta.url));

describe('the Canvas webview bundle', () => {
  it('is built, and is the runtime and not the compiler', () => {
    expect(existsSync(BUNDLE), `${BUNDLE} is missing; run npm run build`).toBe(true);
    // The runtime alone is about 50 KB; the compiler with TypeScript is over 10 MB. A bound
    // between them says which one this is without pinning the runtime's size to the byte.
    expect(statSync(BUNDLE).size).toBeLessThan(500 * 1024);
    const text = readFileSync(BUNDLE, 'utf8');
    expect(text).not.toMatch(/createSourceFile|SyntaxKind|typescript/);
    expect(text).toContain('createRuntime');
  });

  it('is a script a webview can load with a plain tag under the panel policy', () => {
    const text = readFileSync(BUNDLE, 'utf8');
    // An IIFE: no module syntax at the top level, and no `require`, which a webview has not.
    expect(text).not.toMatch(/^(import|export) /m);
    expect(text).not.toMatch(/\brequire\(/);
    // The policy admits scripts by nonce and has no `unsafe-eval`.
    expect(text).not.toMatch(/\beval\(|new Function\(/);
  });
});
