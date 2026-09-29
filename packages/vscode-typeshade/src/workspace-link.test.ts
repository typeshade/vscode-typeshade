// The link and the folder are formats the site writes too, so these tests hold this module to
// the site's own bytes: the link below was written by typeshade.github.io's
// `src/scripts/source-link.ts` (`encodeSource`, in a browser's `CompressionStream`), not by this
// module.

import { describe, expect, it } from 'vitest';
import {
  decodeSource,
  encodeSource,
  folderOf,
  planLink,
  readLink,
  readManifest,
  shortLinkTarget,
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

describe('which links may be fetched', () => {
  it("follows a short link on the site's own origin, and only that", () => {
    expect(planLink('https://typeshade.dev/s/AbC123/')).toEqual({
      kind: 'fetch',
      url: 'https://typeshade.dev/s/AbC123/',
    });
    expect(planLink('https://typeshade.dev/s/AbC123')).toEqual({
      kind: 'fetch',
      url: 'https://typeshade.dev/s/AbC123',
    });
  });

  it('never fetches a short link on any other origin', () => {
    for (const link of [
      'https://evil.example/s/AbC123/',
      'http://typeshade.dev/s/AbC123/',
      'https://typeshade.dev:8443/s/AbC123/',
      'https://www.typeshade.dev/s/AbC123/',
      'https://typeshade.dev.evil.example/s/AbC123/',
      'https://typeshade.dev@evil.example/s/AbC123/',
      'https://evil.example/s/AbC123/#code=zUyo',
      'http://169.254.169.254/s/latest/',
    ])
      expect(planLink(link)).toEqual({ kind: 'fragment', link });
  });

  it('reads a link that is not a short link from its own fragment', () => {
    for (const link of [
      SITE_LINK,
      'https://typeshade.dev/s/',
      'https://typeshade.dev/s/a/b',
      'https://typeshade.dev/sx/AbC123/',
      'https://typeshade.dev/playground/',
      'code=zUyo&passes=a:b.shade.ts',
      '',
    ])
      expect(planLink(link)).toEqual({ kind: 'fragment', link });
  });

  it('reads a bare fragment or a link on another origin, never fetching it', () => {
    const link = writeLink(workspace, 'https://example.org');
    const plan = planLink(link);
    expect(plan.kind).toBe('fragment');
    expect(readLink(link)).toEqual({ kind: 'workspace', workspace });
  });
});

describe('where a short link may redirect', () => {
  const SHORT = 'https://typeshade.dev/s/AbC123/';

  it('accepts a redirect back to the site, absolute or relative', () => {
    expect(shortLinkTarget(SHORT, 302, 'https://typeshade.dev/playground/#code=zUyo')).toBe(
      'https://typeshade.dev/playground/#code=zUyo',
    );
    expect(shortLinkTarget(SHORT, 301, '/ko/playground/#code=zUyo')).toBe(
      'https://typeshade.dev/ko/playground/#code=zUyo',
    );
  });

  it('fails closed on a redirect to another origin', () => {
    for (const location of [
      'https://evil.example/playground/#code=zUyo',
      'http://typeshade.dev/playground/#code=zUyo',
      '//evil.example/playground/#code=zUyo',
      'https://typeshade.dev.evil.example/',
      'https://typeshade.dev@evil.example/',
    ])
      expect(() => shortLinkTarget(SHORT, 302, location)).toThrow(/redirects away/);
  });

  it('fails closed on a response that is no redirect', () => {
    expect(() => shortLinkTarget(SHORT, 200, null)).toThrow(/does not redirect \(200\)/);
    expect(() => shortLinkTarget(SHORT, 302, null)).toThrow(/does not redirect \(302\)/);
    expect(() => shortLinkTarget(SHORT, 200, '/playground/')).toThrow(/does not redirect/);
    expect(() => shortLinkTarget(SHORT, 404, '/playground/')).toThrow(/does not redirect/);
  });
});
