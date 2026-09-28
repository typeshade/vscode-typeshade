// The link and the folder are formats the site writes too, so these tests hold this module to
// the site's own bytes: the link below was written by typeshade.github.io's
// `src/scripts/source-link.ts` (`encodeSource`, in a browser's `CompressionStream`), not by this
// module.

import { describe, expect, it } from 'vitest';
import {
  decodeSource,
  encodeSource,
  folderOf,
  readLink,
  readManifest,
  writeLink,
  type Workspace,
} from './workspace-link.js';

const MAIN = '"use typeshade";\nimport { fade } from "./passes/trail.shade.ts";\n// é ✓\n';
const TRAIL = '"use typeshade";\nexport const fade = 0.96;\n';

/** Written by the site's encoder over MAIN and { 'passes/trail.shade.ts': TRAIL }. */
const SITE_LINK =
  'https://typeshade.dev/playground/#code=zUyotTlUoqSxILc5ITElVsubKzC3ILypRqFZIS0xJVahVSCvKz1VQ0tMvSCwuTi3WLylKzMzRAyvWKylWsubS11c4vFLh0ZzJXAA&files=zq1YqSCwuTi3WLylKzMzRK85ITEnVKylWslKKUSotTlUoqSxIBQvGKFnH5KVWFOQXlSgk5-cVlyikJaakKtgqGOhZmlnH5CnVAgA&passes=trail:passes/trail.shade.ts&backend=webgl2';

const workspace: Workspace = {
  main: { path: 'hello.shade.ts', text: MAIN },
  files: { 'passes/trail.shade.ts': TRAIL },
  passes: [{ name: 'trail', file: 'passes/trail.shade.ts' }],
};

describe('the Playground link', () => {
  it('reads a link the site wrote: the main file, the files beside it and the graph', () => {
    expect(readLink(SITE_LINK)).toEqual({ kind: 'workspace', workspace });
  });

  it('writes a link that reads back to the same workspace', () => {
    const link = writeLink(workspace);
    expect(link.startsWith('https://typeshade.dev/playground/#code=z')).toBe(true);
    expect(link).toContain('&passes=trail:passes/trail.shade.ts');
    expect(readLink(link)).toEqual({ kind: 'workspace', workspace });
  });

  it('reads the uncompressed form a browser without CompressionStream writes', () => {
    const plain = `u${Buffer.from(MAIN, 'utf8').toString('base64url')}`;
    expect(decodeSource(plain)).toBe(MAIN);
    expect(decodeSource(encodeSource(MAIN))).toBe(MAIN);
  });

  it('names an example or a blank file it does not carry', () => {
    expect(readLink('example=feedback-trail&backend=cpu')).toEqual({
      kind: 'example',
      id: 'feedback-trail',
    });
    expect(readLink('blank=1')).toEqual({ kind: 'blank' });
    expect(() => readLink('backend=cpu')).toThrow(/names no code/);
  });

  it('refuses a graph that names a file the link has not', () => {
    const link = writeLink({ ...workspace, passes: [] }).concat(
      '&passes=blur:passes/blur.shade.ts',
    );
    expect(() => readLink(link)).toThrow(/passes\/blur\.shade\.ts/);
  });

  it('refuses a file above the main file, which the Playground cannot hold', () => {
    expect(() =>
      writeLink({ ...workspace, files: { '../lib/noise.shade.ts': TRAIL }, passes: [] }),
    ).toThrow(/cannot hold it/);
  });
});

describe('the folder', () => {
  it("writes the site's layout: the files, typeshade.json, tsconfig.json and the recommendation", () => {
    const folder = folderOf(workspace);
    expect(Object.keys(folder)).toEqual([
      'hello.shade.ts',
      'passes/trail.shade.ts',
      'typeshade.json',
      'tsconfig.json',
      '.vscode/extensions.json',
    ]);
    expect(readManifest(folder['typeshade.json']!)).toEqual({
      main: 'hello.shade.ts',
      passes: workspace.passes,
    });
    expect(JSON.parse(folder['.vscode/extensions.json']!)).toEqual({
      recommendations: ['typeshade.vscode-typeshade'],
    });
  });

  it('reads a typeshade.json with no passes, and refuses one with no main file', () => {
    expect(readManifest('{ "main": "a.shade.ts" }')).toEqual({ main: 'a.shade.ts', passes: [] });
    expect(() => readManifest('{ "passes": [] }')).toThrow(/main/);
    expect(() => readManifest('{ "main": "a.shade.ts", "passes": [1] }')).toThrow(/passes/);
  });
});
