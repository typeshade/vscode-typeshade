// === The fixture project the tsserver test drives ===
//
// Test-only. `docs/design.md` §6 names what this has to contain, and every file here exists
// because one assertion needs it rather than for completeness: a clean shader, a shader with a
// real TypeShade error, a syntax error, an importing pair, a plain TypeScript file, a host file
// that imports a shader, and a shader long enough to cross the 500-line threshold at which
// tsserver switches to `getRegionSemanticDiagnostics`.
//
// The shaders are written in the language the compiler's own examples use, and each was run
// through `createTypeshadeLanguageService` before any assertion was written against it, so a
// failing test means the plugin broke rather than the fixture being wrong about the language.

/** A shader with nothing wrong with it. `tint` is called once and declared once, which is what
 *  the references assertion counts. */
export const CLEAN = `"use typeshade"

class Color {
  @location(0) color: vec4
}

export function tint(x: f32): f32 {
  return x * 0.5
}

@fragment
export function fs(): Color {
  return { color: vec4(tint(1.), 0., 0., 1.) }
}
`;

/** The same shader with its directive removed, for the transition that only `closeDocument` can
 *  handle: the file stays in the project, so no prune reaches it. */
export const CLEAN_WITHOUT_DIRECTIVE = CLEAN.replace('"use typeshade"\n', '');

/** A shader with a real TypeShade error: a call to a function that does not exist, which the
 *  front end reports as `UNKNOWN_FN` (TS8004). */
export const BROKEN = `"use typeshade"

@fragment
export function fs(): f32 {
  return nope(1.)
}
`;

/** A shader with a parse error, for the assertion that one broken paren is underlined once. */
export const SYNTAX = `"use typeshade"

@fragment
export function fs(): f32 {
  return vec4(1., 0.
}
`;

/** The imported half of the pair. */
export const LIB = `"use typeshade"

export function double(x: f32): f32 {
  return x * 2.
}
`;

/** The importing half. The specifier is `./lib.shade.js`, not `./lib.js`: the service resolves
 *  a relative import by rewriting a trailing `.js` to `.ts`, so `./lib.js` would look for
 *  `lib.ts` and find nothing. */
export const MAIN = `"use typeshade"

import { double } from './lib.shade.js'

@fragment
export function fs(): f32 {
  return double(2.)
}
`;

/** A shader whose struct field carries a `@builtin(...)`, for the one completion no TypeScript
 *  program could produce. The cursor goes inside that string, and a STRUCT FIELD is the right
 *  place for it rather than an entry point's parameter: the service filters the ids to the
 *  enclosing function's stage, so a parameter would offer the vertex pair or the fragment four
 *  but never both, and the assertion wants the whole vocabulary. */
export const BUILTIN = `"use typeshade"

class Clip {
  @builtin("position") pos: vec4
}

@vertex
export function vs(): Clip {
  return { pos: vec4(0., 0., 0., 1.) }
}
`;

/** A shader whose exported function carries a doc comment, for the hover split. The service
 *  renders a documented symbol as a fenced signature followed by prose, which is the only shape
 *  that exercises both halves of `splitHover`: an undocumented one is fence-only and a builtin
 *  id is prose-only. */
export const DOCUMENTED = `"use typeshade"

/** Halves a value, which is the whole of what it does. */
export function tint(x: f32): f32 {
  return x * 0.5
}

@fragment
export function fs(): f32 {
  return tint(1.)
}
`;

/** A shader with an import it does not use, so `organizeImports` and `getPasteEdits` have
 *  something to do. On `broken.shade.ts` they answer empty from both servers, which made the
 *  assertion about them true without the plugin. */
export const UNUSED_IMPORT = `"use typeshade"

import { double } from './lib.shade.js'

@fragment
export function fs(): f32 {
  return 1.
}
`;

/** A plain TypeScript file, for the pass-through equality assertion. Nothing about it is
 *  TypeShade, and the plugin must leave every answer about it byte for byte as it was. */
export const HOST = `export interface Frame {
  readonly width: number
  readonly height: number
}

export function area(frame: Frame): number {
  return frame.width * frame.height
}

export const first: Frame = { width: 1, height: 1 }
`;

/** A host file that imports a shader, which is the §1.6 case: the host side stays plain
 *  TypeScript and the plugin does not touch it. */
export const HOST_IMPORTS_SHADER = `import { fs } from './clean.shade.js'

export const entry = fs
`;

/**
 * A shader of at least `lines` lines, which is what puts it past tsserver's 500-line region
 * diagnostics threshold.
 *
 * @param lines - the least number of lines wanted.
 * @returns the shader's text.
 */
export function longShader(lines: number): string {
  const parts = ['"use typeshade"', ''];
  for (let i = 0; parts.length < lines; i++) {
    parts.push(`export function h${i}(x: f32): f32 {`, `  return x * ${i + 1}.`, '}', '');
  }
  parts.push('@fragment', 'export function fs(): f32 {', '  return h0(1.)', '}');
  return parts.join('\n');
}

/** The tsconfig the fixture project uses: ordinary settings, with no mention of TypeShade. The
 *  plugin arrives through the server's own `--globalPlugins`, which is how VS Code passes it. */
export const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      lib: ['ES2022', 'DOM'],
      strict: true,
      noEmit: true,
    },
    include: ['*.ts'],
  },
  null,
  2,
);

/** Every file of the fixture project, by name. */
export const PROJECT: Readonly<Record<string, string>> = {
  'tsconfig.json': TSCONFIG,
  'clean.shade.ts': CLEAN,
  'broken.shade.ts': BROKEN,
  'syntax.shade.ts': SYNTAX,
  'lib.shade.ts': LIB,
  'main.shade.ts': MAIN,
  'builtin.shade.ts': BUILTIN,
  'documented.shade.ts': DOCUMENTED,
  'unused-import.shade.ts': UNUSED_IMPORT,
  'host.ts': HOST,
  'host-imports-shader.ts': HOST_IMPORTS_SHADER,
  'big.shade.ts': longShader(520),
};

/** A host project that imports shader modules the way the compiler's host import sets it up
 *  (compiler proposals 0009, 0013 and 0016, surface §64, §65 and §67): the host `tsconfig.json`
 *  resolves `./terrain.shade.ts` to the generated host view through `moduleSuffixes`, and
 *  excludes the shader sources. `app.ts` calls a helper; `gpu.ts` calls a `@compute` entry and
 *  draws a full-screen `@fragment` entry; `kernel.ts` calls a kernel function with a
 *  `Float32Array` and with a `Resident`. Each view is the text `tshc sync` writes for its module
 *  at the pin, down to the default export every view now carries, the compiled program; the
 *  compiler's own tests hold the generation, and this fixture holds what the editor makes of it.
 *  The views import `Resident` and `Pack` from `typeshade/runtime`, which a host project has
 *  installed, so the test links the pinned compiler as `node_modules/typeshade`. */
export const HOST_IMPORT_PROJECT: Readonly<Record<string, string>> = {
  'tsconfig.json': JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        allowImportingTsExtensions: true,
        moduleSuffixes: ['.typeshade', ''],
        lib: ['ES2022', 'DOM'],
        strict: true,
        noEmit: true,
      },
      include: ['*.ts'],
      exclude: ['*.shade.ts'],
    },
    null,
    2,
  ),
  'terrain.shade.ts': `"use typeshade"

export function height(p: vec2, k: vec4): f32 {
  return k.x * sin(p.x * k.y) + k.z * cos(p.y * k.w)
}

export function normal(p: vec2, k: vec4): vec3 {
  const e = 0.001
  const dx = height(p + vec2(e, 0.), k) - height(p - vec2(e, 0.), k)
  const dy = height(p + vec2(0., e), k) - height(p - vec2(0., e), k)
  return normalize(vec3(-dx, 2. * e, -dy))
}
`,
  'terrain.shade.typeshade.ts': `// Generated by typeshade from terrain.shade.ts. Do not edit; \`tshc sync\` rewrites it.

import type { Pack } from "typeshade/runtime";
export declare function height(p: readonly [number, number], k: readonly [number, number, number, number]): number;
export declare function normal(p: readonly [number, number], k: readonly [number, number, number, number]): [number, number, number];
/** The compiled program, its manifest: the shader text, each binding with its byte layout and each entry with the bindings it reaches, which the program runtime loads (Rule 11.10). */
declare const program: Pack;
export default program;
`,
  'app.ts': `import { height, normal } from './terrain.shade.ts'

const k = [1, 0.5, 2, 0.25] as const
export const h: number = height([0.5, 0.5], k)
export const n: [number, number, number] = normal([0.5, 0.5], k)
`,
  'kernels.shade.ts': `"use typeshade"

declare const k: uniform<f32>
declare const xs: storage<array<f32>>
declare const ys: storage<array<f32>, "read_write">

@compute([64])
export function scale(@builtin("global_invocation_id") gid: vec3u) {
  if (gid.x >= xs.length) {
    return
  }
  ys[gid.x] = xs[gid.x] * k
}
`,
  'kernels.shade.typeshade.ts': `// Generated by typeshade from kernels.shade.ts. Do not edit; \`tshc sync\` rewrites it.

import type { Resident } from "typeshade/runtime";
import type { Pack } from "typeshade/runtime";
/** A \`@compute\` entry, \`@workgroup_size(64, 1, 1)\`: \`workgroups\` counts workgroups, dispatched as written, and each binding the entry writes is read back into your value in place, or stays on the device in a Resident (Rules 8.24 and 11.8). */
export declare function scale(bindings: { readonly k: number; readonly xs: Float32Array | Resident<Float32Array>; readonly ys: Resident<Float32Array> }, workgroups: number | readonly [number, number?, number?]): void;
export declare function scale(bindings: { readonly k: number; readonly xs: Float32Array | Resident<Float32Array>; readonly ys: Float32Array | Resident<Float32Array> }, workgroups: number | readonly [number, number?, number?]): Promise<void>;
/** The compiled program, its manifest: the shader text, each binding with its byte layout and each entry with the bindings it reaches, which the program runtime loads (Rule 11.10). */
declare const program: Pack;
export default program;
`,
  'plasma.shade.ts': `"use typeshade"

class Frame {
  time: f32
  scale: f32
}

declare const frame: uniform<Frame>

class Color {
  @location(0) color: vec4
}

@fragment
export function fs(@builtin("position") p: vec4): Color {
  const uv = p.xy * frame.scale
  const v = sin(uv.x + frame.time) * cos(uv.y - frame.time)
  const c = v * 0.5 + 0.5
  return { color: vec4(c, c * c, 1 - c, 1) }
}
`,
  'plasma.shade.typeshade.ts': `// Generated by typeshade from plasma.shade.ts. Do not edit; \`tshc sync\` rewrites it.

import type { Pack } from "typeshade/runtime";
/** A full-screen \`@fragment\` entry: draws one frame into \`target\`, filling its width by height, on WebGPU, then WebGL2, then the CPU. The first draw into a canvas decides its tier. The promise resolves when the frame is submitted; nothing is read back (Rule 8.24). */
export declare function fs(target: HTMLCanvasElement | OffscreenCanvas, bindings: { readonly frame: { readonly time: number; readonly scale: number } }): Promise<void>;
/** The compiled program, its manifest: the shader text, each binding with its byte layout and each entry with the bindings it reaches, which the program runtime loads (Rule 11.10). */
declare const program: Pack;
export default program;
`,
  'gpu.ts': `import { resident } from 'typeshade/runtime'
import { scale } from './kernels.shade.ts'
import { fs } from './plasma.shade.ts'

const xs = Float32Array.from({ length: 256 }, (_, i) => i)
const ys = new Float32Array(256)
export const read: Promise<void> = scale({ k: 2.5, xs, ys }, 4)
export const queued: void = scale({ k: 2.5, xs, ys: resident(new Float32Array(256)) }, 4)

declare const canvas: HTMLCanvasElement
export const frame: Promise<void> = fs(canvas, { frame: { time: 0, scale: 0.02 } })
`,
  'loops.shade.ts': `"use typeshade"

export function height(p: vec2, k: vec4): f32 {
  return k.x * sin(p.x * k.y) + k.z * cos(p.y * k.w)
}

export function render(k: vec4, size: u32, out: array<f32>) {
  for (let i: u32 = 0; i < size * size; i++) {
    const p = vec2(f32(i % size), f32(i / size)) / f32(size)
    out[i] = height(p, k)
  }
}

export function total(xs: array<f32>): f32 {
  let s = 0.
  for (const x of xs) {
    s += x
  }
  return s
}
`,
  'loops.shade.typeshade.ts': `// Generated by typeshade from loops.shade.ts. Do not edit; \`tshc sync\` rewrites it.

import type { Resident } from "typeshade/runtime";
import type { Pack } from "typeshade/runtime";
export declare function height(p: readonly [number, number], k: readonly [number, number, number, number]): number;
/** A kernel function (Rule 8.22). Each of its loops runs on the GPU, one invocation per iteration, where there is WebGPU, and on the CPU otherwise. Each array it writes is read back into yours in place, or stays on the device in a Resident (Rules 8.21 and 11.8). */
export declare function render(k: readonly [number, number, number, number], size: number, out: Resident<Float32Array>): void;
export declare function render(k: readonly [number, number, number, number], size: number, out: Float32Array | Resident<Float32Array>): Promise<void>;
/** A kernel function (Rule 8.22). Each of its loops runs on the GPU, one invocation per iteration, where there is WebGPU, and on the CPU otherwise. Each array it writes is read back into yours in place, or stays on the device in a Resident (Rules 8.21 and 11.8). */
export declare function total(xs: Float32Array | Resident<Float32Array>): Promise<number>;
/** The compiled program, its manifest: the shader text, each binding with its byte layout and each entry with the bindings it reaches, which the program runtime loads (Rule 11.10). */
declare const program: Pack;
export default program;
`,
  'kernel.ts': `import { resident } from 'typeshade/runtime'
import { render, total } from './loops.shade.ts'

const k = [1, 0.5, 2, 0.25] as const
const img = new Float32Array(64 * 64)
export const filled: Promise<void> = render(k, 64, img)
const dev = resident(new Float32Array(64 * 64))
export const queued: void = render(k, 64, dev)
export const sum: Promise<number> = total(dev)
`,
};

/** A workspace with no `tsconfig.json` at all, which is how most people first open a shader:
 *  tsserver puts the file in an inferred project, whose constructor calls `enableGlobalPlugins`
 *  (`typescript.js:184978`), so the plugin is enabled there too. */
export const INFERRED_PROJECT: Readonly<Record<string, string>> = {
  'clean.shade.ts': CLEAN,
};
