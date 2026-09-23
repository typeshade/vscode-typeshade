// === The shaders the server's tests read from disk ===
//
// Test-only. Each one exists because an assertion needs it, and each was run through the pinned
// compiler before any assertion was written against it, so a failing test means the server
// broke rather than the fixture being wrong about the language. Line numbers matter here: the
// assertions quote them, one-based, the way the tools print them.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A fragment shader with nothing wrong with it. `tint` is declared on line 7 and called on
 *  line 13. */
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

/** Two real errors, on lines 5 and 6: a call to a function that does not exist (`UNKNOWN_FN`,
 *  TS8004, which TypeScript also reports as TS2304) and a vector of the wrong size
 *  (`TYPE_MISMATCH`, TS8003). The front end then also reports `a` on line 7 as unknown
 *  (TS8022), since its declaration did not lower. */
export const BROKEN = `"use typeshade"

@fragment
export function fs(): f32 {
  const a = nope(1.)
  let v: vec2 = vec3(1.)
  return a
}
`;

/** A compute kernel with a uniform struct and a storage array, for binding slots and for a run
 *  with bindings. `camera` is on line 8, `pixels` on line 9, the entry on lines 11 to 15. */
export const KERNEL = `"use typeshade"

class Camera {
  scale: f32
  offset: vec3
}

declare const camera: uniform<Camera>
declare let pixels: storage<array<f32>>

@compute([64, 1, 1])
export function paint(@builtin("global_invocation_id") gid: vec3u) {
  const i = gid.x
  pixels[i] = pixels[i] * camera.scale + camera.offset.x
}
`;

/** A fragment shader that reads a uniform struct and its own position, for a run of an entry
 *  point: at position (100.5, 50.5) with `gain` 2 it returns `vec4(2, 1, 0, 2)`. Line 16 is the
 *  statement after `u` is computed, where a breakpoint sees `u` and not yet `v`. */
export const GRADIENT = `"use typeshade"

class Tint {
  gain: f32
}

class Out {
  @location(0) color: vec4
}

declare const tint: uniform<Tint>

@fragment
export function fs(@builtin("position") pos: vec4): Out {
  const u = pos.x / 100.5
  const v = pos.y / 101.
  return { color: vec4(u, v, 0., 1.) * tint.gain }
}
`;

/** A declaration TypeScript types as `number` and the compiler as `f32`, for the hover that only
 *  the compiler can answer. `x` is declared on line 4 and read on line 5. */
export const FLOAT = `"use typeshade"

export function half(): f32 {
  let x = 1.
  return x * 0.5
}
`;

/** The imported half of a pair. `double` is declared on line 3. */
export const LIB = `"use typeshade"

export function double(x: f32): f32 {
  return x * 2.
}
`;

/** The importing half. It imports `double` without calling it, so the file is clean until the
 *  export it names goes away. */
export const MAIN = `"use typeshade"

import { double } from './lib.shade.js'

export function same(x: f32): f32 {
  return x
}
`;

/** A uniform that is not a struct: the front end accepts it, and the GLSL emitter refuses it,
 *  since GLSL ES 3.00 needs a std140 block. Only `compile()` meets that. */
export const BARE_UNIFORM = `"use typeshade"

class Color {
  @location(0) color: vec4
}

declare const tint: uniform<vec4>

@fragment
export function fs(): Color {
  return { color: tint }
}
`;

/** A derivative, which has no value on the CPU without a stand-in. */
export const DERIVATIVE = `"use typeshade"

class Color {
  @location(0) color: vec4
}

@fragment
export function fs(@builtin("position") pos: vec4): Color {
  const w = fwidth(pos.x)
  return { color: vec4(w, 0., 0., 1.) }
}
`;

/** A loop of 256 trips per level, three levels deep: about 17 million statements, which is past
 *  any budget a test sets. */
export const RUNAWAY = `"use typeshade"

export function heavy(seed: f32): f32 {
  let acc: f32 = seed
  for (let i = 0; i < 256; i++) {
    for (let j = 0; j < 256; j++) {
      for (let k = 0; k < 256; k++) {
        acc = acc + 1.
      }
    }
  }
  return acc
}
`;

/** A plain TypeScript module, which the server must leave alone. */
export const PLAIN = `export const answer = 42;
`;

/** A directory of files on disk, removed by `cleanup`. */
export interface TestProject {
  readonly root: string;
  /** Writes (or rewrites) a file, creating its directory. */
  write(file: string, text: string): string;
  cleanup(): void;
}

/**
 * Creates a temporary project.
 *
 * @param files - relative path to text.
 * @returns the project.
 */
export function testProject(files: Readonly<Record<string, string>>): TestProject {
  const root = mkdtempSync(join(tmpdir(), 'typeshade-mcp-'));
  const write = (file: string, text: string): string => {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  for (const [file, text] of Object.entries(files)) write(file, text);
  return { root, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
