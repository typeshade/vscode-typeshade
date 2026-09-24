import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import typescript from 'typescript';

const require = createRequire(import.meta.url);
const BUNDLE = fileURLToPath(new URL('../dist/index.js', import.meta.url));

describe('the built bundle', () => {
  it('exports the factory itself, which is what tsserver calls', () => {
    // esbuild emits ESM exports as a namespace object, and a namespace object is not callable,
    // so `scripts/build.mjs` adds the line that makes `module.exports` the factory. A plugin
    // with the wrong export loads without an error and then never runs, which is exactly the
    // failure this catches. `npm run build` must have run: `npm run check` does it first.
    expect(existsSync(BUNDLE), `${BUNDLE} is missing; run npm run build`).toBe(true);
    const loaded: unknown = require(BUNDLE);
    expect(typeof loaded).toBe('function');
    const plugin = (loaded as (m: { typescript: typeof typescript }) => { create?: unknown })({
      typescript,
    });
    expect(typeof plugin.create).toBe('function');
  });

  it('needs nothing from the filesystem around it', () => {
    // The bundle carries its own `typescript`, and this is what that is for. It used to be
    // external, and external means node resolves it by walking up from wherever the file sits:
    // inside this repository that finds the workspace's own copy and everything appears to
    // work, while a packaged `.vsix` has nothing to find. Copying the bundle somewhere with no
    // `node_modules` above it is the difference, and it is the difference a real VS Code showed
    // (`src/directive.ts`).
    const away = mkdtempSync(join(tmpdir(), 'typeshade-bundle-'));
    try {
      cpSync(BUNDLE, join(away, 'index.js'));
      const isolated: unknown = createRequire(join(away, 'index.js'))(join(away, 'index.js'));
      expect(typeof isolated).toBe('function');
    } finally {
      rmSync(away, { recursive: true, force: true });
    }
  });

  it('carries no bare require of typescript', () => {
    // The same fact, read off the text rather than by loading it, so a failure says which half
    // regressed: a bare `require("typescript")` in the bundle is a second instance waiting to
    // happen even when one happens to resolve.
    const text = readFileSync(BUNDLE, 'utf8');
    expect(text).not.toMatch(/require\(["']typescript["']\)/);
  });
});
