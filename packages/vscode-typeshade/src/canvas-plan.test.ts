// The Canvas tab's decisions, held without a GPU: what the host fills, what every other binding
// gets, which frame of a pass a reader sees. `canvas.test.ts` runs the same functions over
// manifests the real compiler wrote; these use hand-made ones, so each case says exactly which
// field of the manifest it turns on.

import { describe, expect, it } from 'vitest';
import type { Pack } from './compiler.js';
import {
  CHECKER_SIZE,
  checkPasses,
  checkerTexels,
  passSource,
  planProgram,
  reservedFields,
  reservedValue,
  textureSlot,
  uniformValue,
  zeroValue,
  type FrameClock,
} from './canvas-plan.js';

type Layout = Parameters<typeof reservedFields>[0];

const f32: Layout = { kind: 'scalar', type: 'f32' };
const u32: Layout = { kind: 'scalar', type: 'u32' };
const vec2: Layout = { kind: 'vector', size: 2, type: 'f32' };

const struct = (fields: Record<string, Layout>): Layout => ({
  kind: 'struct',
  size: 64,
  fields: Object.entries(fields).map(([name, layout], i) => ({ name, offset: i * 16, layout })),
});

const CLOCK: FrameClock = {
  seconds: 1.5,
  width: 640,
  height: 360,
  mouse: [0.25, 0.75],
  frame: 7,
  delta: 0.016,
};

describe('the reserved uniform fields', () => {
  it('finds all five at their reserved types', () => {
    const layout = struct({
      time: f32,
      resolution: vec2,
      mouse: vec2,
      frame: u32,
      timeDelta: f32,
      gain: f32,
    });
    expect(reservedFields(layout)).toEqual({
      time: 'time',
      resolution: 'resolution',
      mouse: 'mouse',
      frame: 'frame',
      timeDelta: 'timeDelta',
    });
  });

  it('leaves a field of the same name at another type to the shader, as the site does', () => {
    // `rt-renderer-class` passes an f32 `frame` to its jitter: it is that module's own.
    const layout = struct({
      time: vec2,
      frame: f32,
      timeDelta: u32,
      resolution: { kind: 'vector', size: 3, type: 'f32' },
      mouse: { kind: 'vector', size: 2, type: 'u32' },
    });
    expect(reservedFields(layout)).toEqual({});
  });

  it('finds nothing in a uniform that is no struct', () => {
    expect(reservedFields(f32)).toEqual({});
    expect(reservedFields(vec2)).toEqual({});
  });

  it('writes the clock: seconds, pixels, the pointer, a whole frame number and the step', () => {
    expect(reservedValue('time', CLOCK)).toBe(1.5);
    expect(reservedValue('resolution', CLOCK)).toEqual([640, 360]);
    expect(reservedValue('mouse', CLOCK)).toEqual([0.25, 0.75]);
    expect(reservedValue('frame', CLOCK)).toBe(7);
    expect(reservedValue('frame', { ...CLOCK, frame: 7.9 })).toBe(7);
    expect(reservedValue('timeDelta', CLOCK)).toBe(0.016);
  });

  it('fills a block for one frame: every field present, the reserved ones the clock', () => {
    const layout = struct({ time: f32, gain: f32, tint: { kind: 'vector', size: 3, type: 'f32' } });
    const template = zeroValue(layout);
    const value = uniformValue(template, reservedFields(layout), CLOCK);
    expect(value).toEqual({ time: 1.5, gain: 0, tint: [0, 0, 0] });
    // The template is kept, so the next frame starts from zeroes and not from this one.
    expect(template).toEqual({ time: 0, gain: 0, tint: [0, 0, 0] });
  });
});

describe('a zero host value', () => {
  it('has the shape the runtime packs: a number, components, a flat matrix, elements, fields', () => {
    expect(zeroValue(f32)).toBe(0);
    expect(zeroValue(vec2)).toEqual([0, 0]);
    expect(zeroValue({ kind: 'matrix', columns: 3, rows: 2, columnStride: 8 })).toEqual([
      0, 0, 0, 0, 0, 0,
    ]);
    expect(zeroValue({ kind: 'array', length: 2, stride: 16, element: vec2 })).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(zeroValue(struct({ a: f32, b: struct({ c: u32 }) }))).toEqual({ a: 0, b: { c: 0 } });
  });

  it('has none for an array with no size', () => {
    expect(() => zeroValue({ kind: 'array', length: null, stride: 4, element: f32 })).toThrow(
      /no size/,
    );
  });
});

// ─── what a program's bindings get ───────────────────────────────────────────────────────────

type Binding = Pack['bindings'][number];
type Entry = Pack['entries'][number];

const uniformBinding = (name: string, layout: Layout): Binding =>
  ({
    name,
    space: 'uniform',
    group: 0,
    binding: 0,
    type: 'Uniforms',
    resource: { resourceKind: 'uniform-buffer' },
    stages: ['fragment'],
    layout,
  }) as unknown as Binding;

const textureBinding = (name: string, type = 'texture_2d<f32>'): Binding =>
  ({
    name,
    space: 'uniform',
    group: 0,
    binding: 1,
    type,
    resource: { resourceKind: 'texture', textureDim: '2d', textureElem: 'f32' },
    stages: ['fragment'],
  }) as unknown as Binding;

const samplerBinding = (name: string, comparison = false): Binding =>
  ({
    name,
    space: 'uniform',
    group: 0,
    binding: 2,
    type: comparison ? 'sampler_comparison' : 'sampler',
    resource: { resourceKind: 'sampler', ...(comparison ? { samplerComparison: true } : {}) },
    stages: ['fragment'],
  }) as unknown as Binding;

const vertexEntry = (): Entry =>
  ({ name: 'vs', stage: 'vertex', bindings: [] }) as unknown as Entry;

const fragmentEntry = (reaches: readonly string[], location: number[] = [0]): Entry =>
  ({
    name: 'fs',
    stage: 'fragment',
    bindings: reaches.map((name) => ({ name, writes: false })),
    outputs: location.map((l) => ({ name: `c${l}`, type: 'vec4<f32>', location: l })),
  }) as unknown as Entry;

const program = (bindings: Binding[], entries: Entry[]): Pack =>
  ({ schema: 1, wgsl: '', bindings, entries, features: [] }) as unknown as Pack;

describe('what a program gets bound', () => {
  it('fills a uniform, a texture that is no pass with the checker, and a sampler', () => {
    const pack = program(
      [uniformBinding('u', struct({ time: f32 })), textureBinding('tex'), samplerBinding('smp')],
      [vertexEntry(), fragmentEntry(['u', 'tex', 'smp'])],
    );
    expect(planProgram(pack, [])).toEqual({
      ok: true,
      fills: {
        u: { kind: 'uniform', template: { time: 0 }, reserved: { time: 'time' } },
        tex: { kind: 'checker' },
        smp: { kind: 'sampler' },
      },
    });
  });

  it('gives a texture named like a pass that pass, and leaves a compute entry out of it', () => {
    const pack = program(
      [textureBinding('trail'), textureBinding('unused')],
      [
        vertexEntry(),
        fragmentEntry(['trail']),
        { name: 'cs', stage: 'compute', bindings: [{ name: 'unused', writes: false }] } as Entry,
      ],
    );
    expect(planProgram(pack, ['trail'])).toEqual({
      ok: true,
      fills: { trail: { kind: 'pass', pass: 'trail' } },
    });
  });

  it("does not fill the runtime's own bindings", () => {
    const pack = program([textureBinding('_fp64')], [vertexEntry(), fragmentEntry(['_fp64'])]);
    expect(planProgram(pack, [])).toEqual({ ok: true, fills: {} });
  });

  it('refuses a name a pass has that is not a texture_2d<f32>', () => {
    const pack = program(
      [textureBinding('trail', 'texture_2d<u32>')],
      [vertexEntry(), fragmentEntry(['trail'])],
    );
    expect(planProgram(pack, ['trail'])).toEqual({
      ok: false,
      error: 'trail names a pass, so it must be a texture_2d<f32>, and it is a texture_2d<u32>',
    });
  });

  it('says which binding it cannot fill, in a sentence', () => {
    const storage = {
      ...uniformBinding('data', f32),
      resource: { resourceKind: 'storage-buffer' },
    } as unknown as Binding;
    expect(planProgram(program([storage], [vertexEntry(), fragmentEntry(['data'])]), [])).toEqual({
      ok: false,
      error: 'data is a storage buffer, and the Canvas fills only uniforms, textures and samplers',
    });
    expect(
      planProgram(
        program([samplerBinding('shadow', true)], [vertexEntry(), fragmentEntry(['shadow'])]),
        [],
      ),
    ).toEqual({
      ok: false,
      error: 'shadow is a comparison sampler, and the Canvas has no depth texture to compare',
    });
    expect(
      planProgram(
        program(
          [textureBinding('vol', 'texture_3d<f32>')],
          [vertexEntry(), fragmentEntry(['vol'])],
        ),
        [],
      ),
    ).toEqual({
      ok: false,
      error:
        'vol is a texture_3d<f32>, and the Canvas fills only a texture_2d<f32> (with a pass or the checker)',
    });
    const noLayout = { ...uniformBinding('flags', f32), layout: undefined, noLayout: 'a bool' };
    expect(
      planProgram(
        program([noLayout as unknown as Binding], [vertexEntry(), fragmentEntry(['flags'])]),
        [],
      ),
    ).toEqual({ ok: false, error: 'the uniform flags has no host layout (a bool)' });
  });

  it('needs one vertex entry, one fragment entry and one colour output at location 0', () => {
    const two = program([], [vertexEntry(), fragmentEntry([]), fragmentEntry([])]);
    expect(planProgram(two, [])).toEqual({
      ok: false,
      error:
        'the Canvas draws a program with one @vertex and one @fragment entry, and this one has 1 @vertex entry and 2 @fragment entries',
    });
    const none = program([], [fragmentEntry([])]);
    expect((planProgram(none, []) as { error: string }).error).toContain('0 @vertex entries');
    const mrt = program([], [vertexEntry(), fragmentEntry([], [0, 1])]);
    expect(planProgram(mrt, [])).toEqual({
      ok: false,
      error:
        'the Canvas draws one colour output at @location(0), and @fragment fs writes @location(0) and @location(1)',
    });
    const at1 = program([], [vertexEntry(), fragmentEntry([], [1])]);
    expect((planProgram(at1, []) as { error: string }).error).toContain('@location(1)');
    const silent = program([], [vertexEntry(), fragmentEntry([], [])]);
    expect((planProgram(silent, []) as { error: string }).error).toContain('writes none');
  });
});

// ─── the pass graph ──────────────────────────────────────────────────────────────────────────

describe('which frame of a pass a reader sees (change 0026, rule 3)', () => {
  const order = ['blurX', 'blurY'];

  it('reads a pass drawn earlier in the frame as this frame, and the rest as the frame before', () => {
    // Reader 0 is blurX itself, 1 is blurY, and 2 is the main file.
    expect(passSource(order, 0, 'blurX')).toBe('previous'); // itself
    expect(passSource(order, 0, 'blurY')).toBe('previous'); // drawn later
    expect(passSource(order, 1, 'blurX')).toBe('current');
    expect(passSource(order, 1, 'blurY')).toBe('previous'); // itself
    expect(passSource(order, 2, 'blurX')).toBe('current');
    expect(passSource(order, 2, 'blurY')).toBe('current');
  });

  it('refuses a name that is no pass', () => {
    expect(() => passSource(order, 2, 'glow')).toThrow(/no pass named glow/);
  });

  it('swaps two textures per pass, so the frame before is the one written last frame', () => {
    expect(textureSlot('current', 0)).toBe(0);
    expect(textureSlot('current', 1)).toBe(1);
    expect(textureSlot('previous', 0)).toBe(1); // never written: zeroes on the first frame
    expect(textureSlot('previous', 1)).toBe(0);
    for (let frame = 1; frame < 10; frame++)
      expect(textureSlot('previous', frame)).toBe(textureSlot('current', frame - 1));
  });

  it('refuses a pass list the site would refuse', () => {
    expect(checkPasses(['blurX', 'trail_2'])).toBeUndefined();
    expect(checkPasses([])).toBeUndefined();
    expect(checkPasses(['blur-x'])).toMatch(/no identifier/);
    expect(checkPasses(['2blur'])).toMatch(/no identifier/);
    expect(checkPasses(['a', 'a'])).toMatch(/two passes are named a/);
  });
});

describe('the checker', () => {
  it('is 128 by 128 opaque texels, light and dark squares tinted by where they sit', () => {
    const texels = checkerTexels();
    expect(texels.length).toBe(CHECKER_SIZE * CHECKER_SIZE * 4);
    const at = (x: number, y: number): number[] =>
      Array.from(texels.subarray((y * CHECKER_SIZE + x) * 4, (y * CHECKER_SIZE + x) * 4 + 4));
    for (let i = 3; i < texels.length; i += 4) expect(texels[i]).toBe(255);
    // Sixteen texels make a square: the first is light, its right neighbour square is dark.
    const light = at(2, 2);
    const dark = at(18, 2);
    expect(light[0]! > dark[0]!).toBe(true);
    expect(light[1]! > dark[1]!).toBe(true);
    // Red grows across u, green down v, so a flipped axis shows.
    expect(at(100, 2)[0]! > at(2, 2)[0]!).toBe(true);
    expect(at(2, 100)[1]! > at(2, 2)[1]!).toBe(true);
  });
});
