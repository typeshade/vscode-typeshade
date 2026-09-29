// What the extension host posts to the Canvas webview, over the real compiler: the files a
// workspace draws, the source each one is compiled as, and the message that comes out. The
// examples are the compiler's own two multipass ones (change 0026), read from the pinned
// submodule, so a pin that changes what a pass may bind fails here and not in a user's panel.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FRAGMENT_PRELUDE,
  buildCanvas,
  canvasWorkspace,
  composeSource,
  type CanvasFile,
} from './canvas.js';
import type { CanvasMessage } from './canvas-plan.js';
import { readManifest } from './workspace-link.js';

const EXAMPLES = new URL('../../../vendor/typeshade/examples/', import.meta.url);
const exampleFile = (path: string): CanvasFile => ({
  uri: new URL(path, EXAMPLES).toString(),
  text: readFileSync(fileURLToPath(new URL(path, EXAMPLES)), 'utf8'),
});
const readFromDisk = (uri: string): string | undefined => {
  try {
    return readFileSync(fileURLToPath(uri), 'utf8');
  } catch {
    return undefined;
  }
};

/** A fragment program alone: no `@vertex`, so the site composes the fullscreen triangle in front. */
const FRAGMENT_ONLY = `"use typeshade"

class Uniforms {
  time: f32
  resolution: vec2
  mouse: vec2
  frame: u32
  timeDelta: f32
  gain: f32
}
declare const u: uniform<Uniforms>
declare const tex: texture_2d<f32>
declare const smp: sampler

@fragment
export function main(@location(0) uv: vec2): vec4 {
  const t = textureSample(tex, smp, uv).rgb
  return vec4(t * u.gain * (0.5 + 0.5 * sin(u.time)), 1.)
}
`;

const hello = (text: string): { main: CanvasFile } => ({
  main: { uri: 'file:///w/hello.shade.ts', text },
});

const built = (message: CanvasMessage): Extract<CanvasMessage, { type: 'canvas' }> => {
  if (message.type !== 'canvas') throw new Error(`not built: ${message.message}`);
  return message;
};

describe('which files the Canvas draws', () => {
  const manifest = readManifest(
    JSON.stringify({
      main: 'hello.shade.ts',
      passes: [{ name: 'trail', file: 'passes/trail.shade.ts' }],
    }),
  );

  it('draws the manifest, the passes then the main file, from whichever of them is open', () => {
    const graph = {
      main: 'hello.shade.ts',
      passes: [{ name: 'trail', file: 'passes/trail.shade.ts' }],
    };
    expect(canvasWorkspace('hello.shade.ts', manifest)).toEqual(graph);
    expect(canvasWorkspace('passes/trail.shade.ts', manifest)).toEqual(graph);
    expect(canvasWorkspace('./passes\\trail.shade.ts', manifest)).toEqual(graph);
  });

  it('draws a file the manifest does not name by itself, and a folder with no manifest too', () => {
    expect(canvasWorkspace('scratch.shade.ts', manifest)).toEqual({
      main: 'scratch.shade.ts',
      passes: [],
    });
    expect(canvasWorkspace('hello.shade.ts', undefined)).toEqual({
      main: 'hello.shade.ts',
      passes: [],
    });
  });
});

describe('the source the compiler is given', () => {
  it('puts the fullscreen vertex half after the directive of a fragment program alone', () => {
    const composed = composeSource(FRAGMENT_ONLY);
    expect(composed.text.startsWith('"use typeshade"\n')).toBe(true);
    expect(composed.text).toContain(FRAGMENT_PRELUDE);
    expect(composed.at).toBe(1);
    expect(composed.text.split('\n').length - FRAGMENT_ONLY.split('\n').length).toBe(
      composed.lines,
    );
  });

  it('leaves alone a file with its own vertex entry, one without a fragment, or one without the directive', () => {
    const withVertex = FRAGMENT_ONLY.replace(
      '@fragment',
      '@vertex\nexport function v() {}\n@fragment',
    );
    expect(composeSource(withVertex)).toEqual({ text: withVertex, at: 0, lines: 0 });
    const kernel = '"use typeshade"\n@compute([1])\nexport function k() {}\n';
    expect(composeSource(kernel).lines).toBe(0);
    expect(composeSource('export const x = 1\n').lines).toBe(0);
    // A comment that says @vertex does not make it a module, as on the site.
    const commented = FRAGMENT_ONLY.replace(
      '@fragment',
      '// the @vertex half is written for you\n@fragment',
    );
    expect(composeSource(commented).lines).toBeGreaterThan(0);
  });

  it('leaves alone a file that declares the names the prelude brings', () => {
    const own = FRAGMENT_ONLY.replace(
      '@fragment',
      'class VsOut { @location(0) uv: vec2 }\n@fragment',
    );
    expect(composeSource(own).lines).toBe(0);
  });
});

describe('the message for a fragment program alone', () => {
  const message = built(
    buildCanvas({ ...hello(FRAGMENT_ONLY), passes: [], readDocument: () => undefined }),
  );

  it('is one program, main, with the reserved fields found and the rest bound', () => {
    expect(message.passes).toEqual([]);
    expect(message.main.name).toBe('main');
    expect(message.main.file).toBe('hello.shade.ts');
    expect(message.main.fills.tex).toEqual({ kind: 'checker' });
    expect(message.main.fills.smp).toEqual({ kind: 'sampler' });
    const uniform = message.main.fills.u;
    expect(uniform?.kind).toBe('uniform');
    if (uniform?.kind !== 'uniform') return;
    expect(uniform.reserved).toEqual({
      time: 'time',
      resolution: 'resolution',
      mouse: 'mouse',
      frame: 'frame',
      timeDelta: 'timeDelta',
    });
    // Every field is there, gain included, because the runtime refuses a struct with one missing.
    expect(uniform.template).toEqual({
      time: 0,
      resolution: [0, 0],
      mouse: [0, 0],
      frame: 0,
      timeDelta: 0,
      gain: 0,
    });
  });

  it('carries the manifest the runtime loads: its schema, the WGSL and both entries', () => {
    expect(message.main.manifest.schema).toBe(1);
    expect(message.main.manifest.wgsl).toContain('@fragment');
    expect(message.main.manifest.entries.map((e) => `${e.stage} ${e.name}`)).toEqual([
      'vertex fullscreen',
      'fragment main',
    ]);
  });

  it('survives the trip to a webview, which is JSON', () => {
    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
  });
});

describe('the message for a graph of passes', () => {
  it('draws separable-blur: blurX first, read by the main file in the frame it was drawn', () => {
    const message = built(
      buildCanvas({
        main: exampleFile('separable-blur.shade.ts'),
        passes: [{ name: 'blurX', ...exampleFile('passes/blur-x.shade.ts') }],
        readDocument: readFromDisk,
      }),
    );
    expect(message.passes.map((p) => p.name)).toEqual(['blurX']);
    expect(message.main.fills.blurX).toEqual({ kind: 'pass', pass: 'blurX' });
  });

  it('draws feedback-trail: the pass reads itself, and its uniform block gets the clock', () => {
    const message = built(
      buildCanvas({
        main: exampleFile('feedback-trail.shade.ts'),
        passes: [{ name: 'trail', ...exampleFile('passes/trail.shade.ts') }],
        readDocument: readFromDisk,
      }),
    );
    const [trail] = message.passes;
    expect(trail?.fills.trail).toEqual({ kind: 'pass', pass: 'trail' });
    const uniform = trail?.fills.u;
    expect(uniform?.kind === 'uniform' && uniform.reserved).toEqual({
      time: 'time',
      resolution: 'resolution',
      frame: 'frame',
    });
    expect(message.main.fills.trail).toEqual({ kind: 'pass', pass: 'trail' });
  });
});

describe('what stops a graph from being drawn', () => {
  it('names the file and the line the reader wrote, past the lines the prelude added', () => {
    // The unknown function is on line 17 of the file, and 17 + the prelude's lines in the
    // text the compiler saw: the panel must say 17.
    const text = FRAGMENT_ONLY.replace('sin(u.time)', 'wobble(u.time)');
    const line = text.split('\n').findIndex((l) => l.includes('wobble')) + 1;
    const message = buildCanvas({ ...hello(text), passes: [], readDocument: () => undefined });
    expect(message.type).toBe('canvas-error');
    const sentence = (message as { message: string }).message;
    expect(sentence).toContain('1 error in hello.shade.ts');
    expect(sentence).toContain(`hello.shade.ts:${line}:`);
  });

  it('says which pass, when the pass is the one that does not compile', () => {
    const message = buildCanvas({
      main: exampleFile('feedback-trail.shade.ts'),
      passes: [
        { name: 'trail', uri: 'file:///w/passes/trail.shade.ts', text: '"use typeshade"\nfoo(\n' },
      ],
      readDocument: readFromDisk,
    });
    expect(message.type).toBe('canvas-error');
    expect((message as { message: string }).message).toMatch(/^the pass trail: .*trail\.shade\.ts/);
  });

  it('refuses a graph whose pass names are not usable, before compiling anything', () => {
    const message = buildCanvas({
      main: exampleFile('feedback-trail.shade.ts'),
      passes: [{ name: 'trail-1', uri: 'file:///w/p.shade.ts', text: '' }],
      readDocument: readFromDisk,
    });
    expect(message).toEqual({
      type: 'canvas-error',
      message: 'the pass name trail-1 is no identifier',
    });
  });

  it('says which binding the Canvas cannot fill', () => {
    const text = FRAGMENT_ONLY.replace(
      'declare const smp: sampler',
      'declare const smp: sampler\ndeclare const data: storage<array<f32>>',
    ).replace('u.gain *', 'data[0] * u.gain *');
    const message = buildCanvas({ ...hello(text), passes: [], readDocument: () => undefined });
    expect(message).toEqual({
      type: 'canvas-error',
      message:
        'hello.shade.ts: data is a storage buffer, and the Canvas fills only uniforms, textures and samplers',
    });
  });

  it('follows an import, so a shader that imports a helper is drawn with it', () => {
    const helper = '"use typeshade"\nexport function halve(x: f32): f32 { return x * 0.5 }\n';
    const text = `"use typeshade"\nimport { halve } from './helper.shade.ts'\n${FRAGMENT_ONLY.replace('"use typeshade"\n', '').replace('u.gain *', 'halve(u.gain) *')}`;
    const files = new Map([['file:///w/helper.shade.ts', helper]]);
    const message = buildCanvas({
      ...hello(text),
      passes: [],
      readDocument: (uri) => files.get(uri),
    });
    expect(message.type).toBe('canvas');
    expect(built(message).main.manifest.wgsl).toContain('halve');
  });
});
