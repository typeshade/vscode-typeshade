// === What the Canvas tab decides before a pixel is drawn, with no `vscode` and no compiler ===
//
// `docs/playground-bridge.md` §3. The extension host compiles (it holds the language service) and
// the webview draws (it holds the runtime, `typeshade/runtime`), and the two meet in a message. The
// choices that make the drawing the Playground's drawing are here, as plain functions of a
// manifest, so that both sides import one copy and vitest can hold it without a GPU:
//
//   - which uniform fields the host fills (`time`, `resolution`, `mouse`, `frame`, `timeDelta`),
//     the site's live-shader contract (typeshade.github.io `src/lib/live-shader-contract.ts`);
//   - what every other binding of a program gets, or why the Canvas refuses the program;
//   - which texture a binding named like a pass reads (compiler change 0026, rule 3): this
//     frame's output of a pass drawn earlier, the previous frame's of itself or a later one;
//   - the checker a `texture_2d<f32>` that is no pass gets.
//
// The only import is a type, so a bundle that includes this file carries no compiler and no
// runtime code from it.

import type { Pack, PackBinding, PackEntry } from './compiler.js';

/** A binding's byte layout in the manifest. */
type PackLayout = NonNullable<PackBinding['layout']>;

// ─── the reserved uniform fields ─────────────────────────────────────────────────────────────

/** The uniform fields the host fills every frame (the site's `RESERVED_UNIFORMS`). */
export type ReservedField = 'time' | 'resolution' | 'mouse' | 'frame' | 'timeDelta';

/** What each reserved field must be for the host to fill it: a field of the same name at another
 *  type stays the shader's own, as on the site (`frame` and `timeDelta` came to the contract
 *  after examples used the names for fields of their own). */
const RESERVED: Readonly<Record<ReservedField, (layout: PackLayout) => boolean>> = {
  time: (l) => l.kind === 'scalar' && l.type === 'f32',
  resolution: (l) => l.kind === 'vector' && l.size === 2 && l.type === 'f32',
  mouse: (l) => l.kind === 'vector' && l.size === 2 && l.type === 'f32',
  frame: (l) => l.kind === 'scalar' && l.type === 'u32',
  timeDelta: (l) => l.kind === 'scalar' && l.type === 'f32',
};

const isReservedName = (name: string): name is ReservedField =>
  Object.prototype.hasOwnProperty.call(RESERVED, name);

/**
 * The fields of a uniform struct the host fills, by name.
 *
 * @param layout - the binding's layout, from the manifest.
 * @returns the reserved fields the struct declares at their reserved types; empty for a uniform
 *   that is no struct.
 */
export function reservedFields(layout: PackLayout): Readonly<Record<string, ReservedField>> {
  const found: Record<string, ReservedField> = {};
  if (layout.kind !== 'struct') return found;
  for (const field of layout.fields)
    if (isReservedName(field.name) && RESERVED[field.name](field.layout))
      found[field.name] = field.name;
  return found;
}

/** The clock and the pointer a frame is drawn with. */
export interface FrameClock {
  /** Seconds since the drawing started. */
  readonly seconds: number;
  /** The drawing buffer's size in pixels. */
  readonly width: number;
  readonly height: number;
  /** The pointer over the canvas in 0 to 1, origin at the bottom left. */
  readonly mouse: readonly [number, number];
  /** Frames drawn since the clock started, 0 on the first. */
  readonly frame: number;
  /** Seconds since the frame before, 0 on the first. */
  readonly delta: number;
}

/**
 * What the host writes into one reserved field.
 *
 * @param field - the field.
 * @param clock - this frame's clock and pointer.
 * @returns a number, or the two components of a `vec2`.
 */
export function reservedValue(field: ReservedField, clock: FrameClock): number | [number, number] {
  switch (field) {
    case 'time':
      return clock.seconds;
    case 'resolution':
      return [clock.width, clock.height];
    case 'mouse':
      return [clock.mouse[0], clock.mouse[1]];
    case 'frame':
      return Math.max(0, Math.floor(clock.frame));
    case 'timeDelta':
      return clock.delta;
  }
}

/**
 * The plain host value of a uniform block for one frame: every field zero (the runtime's packer
 * refuses a struct with a field missing) and each reserved field the clock's.
 *
 * @param template - {@link zeroValue} of the binding's layout, from the message.
 * @param reserved - the reserved fields of the struct, from {@link reservedFields}.
 * @param clock - this frame's clock and pointer.
 */
export function uniformValue(
  template: unknown,
  reserved: Readonly<Record<string, ReservedField>>,
  clock: FrameClock,
): unknown {
  if (typeof template !== 'object' || template === null || Array.isArray(template)) return template;
  const value: Record<string, unknown> = { ...(template as Record<string, unknown>) };
  for (const [name, field] of Object.entries(reserved)) value[name] = reservedValue(field, clock);
  return value;
}

/**
 * A plain host value of a layout with every number zero, in the shape the runtime packs
 * (Rule 8.21): a number, a list of components, a flat list of a matrix's, a list of elements, an
 * object of fields.
 *
 * @throws for a runtime-sized array, which has no size to zero.
 */
export function zeroValue(layout: PackLayout): unknown {
  switch (layout.kind) {
    case 'scalar':
      return 0;
    case 'vector':
      return new Array<number>(layout.size).fill(0);
    case 'matrix':
      return new Array<number>(layout.columns * layout.rows).fill(0);
    case 'array': {
      if (layout.length === null) throw new Error('a runtime-sized array has no size to zero');
      return Array.from({ length: layout.length }, () => zeroValue(layout.element));
    }
    case 'struct':
      return Object.fromEntries(layout.fields.map((f) => [f.name, zeroValue(f.layout)]));
  }
}

// ─── what a program's bindings get ───────────────────────────────────────────────────────────

/** What the webview binds to one name. */
export type Fill =
  /** A uniform block: `template` is its zero value, `reserved` the fields the host fills. */
  | {
      readonly kind: 'uniform';
      readonly template: unknown;
      readonly reserved: Readonly<Record<string, ReservedField>>;
    }
  /** A texture named like a pass: that pass's output. */
  | { readonly kind: 'pass'; readonly pass: string }
  /** A texture that is no pass: the checker. */
  | { readonly kind: 'checker' }
  /** A filtering sampler. */
  | { readonly kind: 'sampler' };

/** A program's bindings by name, or why the Canvas cannot draw it. */
export type ProgramPlan =
  | { readonly ok: true; readonly fills: Readonly<Record<string, Fill>> }
  | { readonly ok: false; readonly error: string };

const TEXTURE_2D_F32 = 'texture_2d<f32>';

/**
 * What the webview binds for each name a program's render entries reach.
 *
 * The Canvas draws one full-screen triangle with a `@vertex` and a `@fragment` entry, so it
 * needs exactly one of each; a program with a compute entry beside them is still drawn, and the
 * compute entry is ignored. Every binding the pair reaches gets a value, or the whole program is
 * refused with a sentence that names the binding: a half-bound draw would be a validation error
 * in a GPU log instead of a sentence in the panel.
 *
 * @param manifest - the compiled program.
 * @param passNames - the names of the graph's passes, which a `texture_2d<f32>` may be named by.
 */
export function planProgram(manifest: Pack, passNames: readonly string[]): ProgramPlan {
  const vertex = manifest.entries.filter((e) => e.stage === 'vertex');
  const fragment = manifest.entries.filter((e) => e.stage === 'fragment');
  if (vertex.length !== 1 || fragment.length !== 1)
    return {
      ok: false,
      error: `the Canvas draws a program with one @vertex and one @fragment entry, and this one has ${count(vertex.length, '@vertex entry', '@vertex entries')} and ${count(fragment.length, '@fragment entry', '@fragment entries')}`,
    };
  const outputs = (fragment[0] as PackEntry).outputs ?? [];
  const locations = outputs.filter((o) => o.location !== undefined).map((o) => o.location);
  if (locations.length !== 1 || locations[0] !== 0)
    return {
      ok: false,
      error: `the Canvas draws one colour output at @location(0), and @fragment ${(fragment[0] as PackEntry).name} writes ${locations.length === 0 ? 'none' : locations.map((l) => `@location(${String(l)})`).join(' and ')}`,
    };

  const reached = new Set(
    [...vertex, ...fragment].flatMap((e) => (e.bindings ?? []).map((b) => b.name)),
  );
  const byName = new Map(manifest.bindings.map((b) => [b.name, b]));
  const fills: Record<string, Fill> = {};
  for (const name of reached) {
    if (name.startsWith('_')) continue; // the runtime's own (the fp64 guard)
    const binding = byName.get(name);
    if (binding === undefined) continue;
    const filled = fillFor(binding, passNames);
    if (typeof filled === 'string') return { ok: false, error: filled };
    fills[name] = filled;
  }
  return { ok: true, fills };
}

/** One binding's fill, or the sentence that says why it has none. */
function fillFor(b: PackBinding, passNames: readonly string[]): Fill | string {
  const r = b.resource;
  const namedPass = passNames.includes(b.name);
  // A name the graph gave a pass must be a `texture_2d<f32>` wherever it is bound (0026's
  // registry refusal), or the shader reads something that is not the pass it names.
  if (namedPass && b.type !== TEXTURE_2D_F32)
    return `${b.name} names a pass, so it must be a ${TEXTURE_2D_F32}, and it is a ${b.type}`;
  switch (r.resourceKind) {
    case 'uniform-buffer': {
      if (b.layout === undefined)
        return `the uniform ${b.name} has no host layout${b.noLayout === undefined ? '' : ` (${b.noLayout})`}`;
      return {
        kind: 'uniform',
        template: zeroValue(b.layout),
        reserved: reservedFields(b.layout),
      };
    }
    case 'texture':
      if (b.type !== TEXTURE_2D_F32)
        return `${b.name} is a ${b.type}, and the Canvas fills only a ${TEXTURE_2D_F32} (with a pass or the checker)`;
      return namedPass ? { kind: 'pass', pass: b.name } : { kind: 'checker' };
    case 'sampler':
      if (r.samplerComparison === true)
        return `${b.name} is a comparison sampler, and the Canvas has no depth texture to compare`;
      return { kind: 'sampler' };
    case 'storage-buffer':
      return `${b.name} is a storage buffer, and the Canvas fills only uniforms, textures and samplers`;
    case 'storage-texture':
      return `${b.name} is a storage texture, and the Canvas fills only uniforms, textures and samplers`;
  }
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ─── the pass graph ──────────────────────────────────────────────────────────────────────────

/** Which frame's output of a pass a reader sees. */
export type PassSource = 'current' | 'previous';

/**
 * Which frame's output of the pass `name` the program at `reader` reads (0026, rule 3).
 *
 * The passes are drawn in order and the main file after them, so `reader` runs from 0 to
 * `order.length`, and `order.length` is the main file. A pass drawn earlier in the frame is read
 * as this frame's output; the pass itself or one drawn later is read as its output from the frame
 * before.
 *
 * @param order - the pass names in draw order.
 * @param reader - the index of the program that binds the texture.
 * @param name - the pass the binding is named after.
 * @throws when `name` is no pass of `order`.
 */
export function passSource(order: readonly string[], reader: number, name: string): PassSource {
  const index = order.indexOf(name);
  if (index < 0) throw new Error(`there is no pass named ${name}`);
  return index < reader ? 'current' : 'previous';
}

/**
 * Which of a pass's two textures a frame writes, or a reader reads.
 *
 * Every pass keeps two textures and swaps them each frame, so the frame before is always the
 * other one: `current` is the texture this frame writes, `previous` the one it wrote last frame,
 * and the first frame's `previous` was never written, which is zeroes.
 *
 * @param source - which frame's output.
 * @param frame - the frame number, from 0.
 * @returns 0 or 1.
 */
export function textureSlot(source: PassSource, frame: number): 0 | 1 {
  const now = Math.abs(Math.floor(frame)) % 2;
  return (source === 'current' ? now : 1 - now) as 0 | 1;
}

/** What is wrong with a pass list, or nothing: a name that is no identifier, or that repeats,
 *  is what the site's registry refuses too. */
export function checkPasses(names: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `the pass name ${name} is no identifier`;
    if (seen.has(name)) return `two passes are named ${name}`;
    seen.add(name);
  }
  return undefined;
}

// ─── the checker ─────────────────────────────────────────────────────────────────────────────

/** The side of the checker, in texels: the site's `textureSize('2d')`. */
export const CHECKER_SIZE = 128;

/**
 * The texels of the UV checker a `texture_2d<f32>` that is no pass gets: `rgba8unorm`, rows from
 * the top. The squares alternate light and dark, and the light ones are tinted by where they sit,
 * red across u and green down v, so a flipped axis shows at a glance (the site's
 * `generateTexels`, `checker`).
 *
 * @param size - the side in texels.
 */
export function checkerTexels(size: number = CHECKER_SIZE): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const on = (Math.floor(u * 8) + Math.floor(v * 8)) % 2 === 0;
      const base = on ? 1 : 0.22;
      const at = (y * size + x) * 4;
      out[at] = Math.round(255 * base * (0.35 + 0.65 * u));
      out[at + 1] = Math.round(255 * base * (0.35 + 0.65 * v));
      out[at + 2] = Math.round(255 * base * 0.35);
      out[at + 3] = 255;
    }
  return out;
}

// ─── the message ─────────────────────────────────────────────────────────────────────────────

/** One program of the graph, as the host sends it: the manifest and what its names are bound to. */
export interface CanvasProgram {
  /** The pass's name; `main` for the main file, which no `texture_2d<f32>` can be named after. */
  readonly name: string;
  /** The file it came from, for a message about it. */
  readonly file: string;
  readonly manifest: Pack;
  readonly fills: Readonly<Record<string, Fill>>;
}

/** What the extension host posts to the Canvas webview. `title` is the active file's name, which
 *  the header shows: the document is written once, so a file switch is a message. */
export type CanvasMessage =
  /** The graph to draw: the passes in draw order, then the main file. Replaces what was drawn. */
  | {
      readonly type: 'canvas';
      readonly passes: readonly CanvasProgram[];
      readonly main: CanvasProgram;
      readonly title?: string;
    }
  /** The graph does not compile or cannot be drawn: the webview keeps drawing what it has and
   *  says why the file is not the one on screen. */
  | { readonly type: 'canvas-error'; readonly message: string; readonly title?: string };

/** What the webview posts back about itself. */
export type CanvasStatus =
  /** No WebGPU here, or no adapter: nothing is drawn. `reason` is one sentence. */
  | { readonly type: 'canvas-status'; readonly state: 'unsupported'; readonly reason: string }
  /** Frames are being drawn. */
  | { readonly type: 'canvas-status'; readonly state: 'drawing'; readonly frame: number }
  /** A load or a frame failed. A failed load leaves the graph before it drawing; a failed frame
   *  stops the loop. */
  | { readonly type: 'canvas-status'; readonly state: 'failed'; readonly reason: string };

/** Everything the webview posts. `canvas-ready` asks for the graph: the script is listening. */
export type WebviewMessage =
  | CanvasStatus
  | { readonly type: 'canvas-ready' }
  | { readonly type: 'selectTab'; readonly tab: string };
