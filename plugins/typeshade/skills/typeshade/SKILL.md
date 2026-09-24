---
name: typeshade
description: Write, fix and review TypeShade shaders, which are TypeScript files that start with the "use typeshade" directive and compile to WGSL and GLSL ES 3.00. Use when creating or editing a .shade.ts or "use typeshade" file, porting a GLSL, HLSL or WGSL shader to TypeShade, wiring TypeShade output into WebGPU or WebGL2 host code, importing a .shade.ts into a host file through typeshade/vite, or reading TypeShade diagnostics (TS8001 to TS8099). Covers the rules that differ from both TypeScript and GLSL, the common diagnostics and their fixes, and the typeshade MCP tools (check, compile, docs, run).
---

# TypeShade

TypeShade is a shader language written as TypeScript. A file whose first line is
`"use typeshade"` is one shader module: the compiler lowers it to WGSL for WebGPU and, where a
form exists, to GLSL ES 3.00 for WebGL2. A host uses it one of two ways: it compiles the file and
builds its own pipelines from the emitted text, or, through the `typeshade/vite` plugin, it
imports the `.shade.ts` and calls its exports, a helper on the CPU and a `@compute` or
full-screen `@fragment` entry on the GPU.

The file looks like TypeScript and is not checked like TypeScript. **The TypeShade compiler
decides what is valid.** Plain `tsc` or a plain TypeScript language server reports errors on
shader files that are not errors (vector arithmetic such as `a + b` on two `vec3`, decorators on
entry functions); do not "fix" those. And it misses real ones (an integer used as an index, a
loop whose step moves away from its bound). Trust the TypeShade tools below. For the same reason, do not run
a code formatter's TypeScript rules over a shader: one that rewrites `1.` as `1` changes a float
into an integer-written literal.

## The working loop

The typeshade MCP server (tools `check`, `compile`, `hover`, `definition`, `references`,
`outline`, `docs`, `run`) answers from TypeShade's own compiler. Use it like this:

1. **After every edit to a shader, call `check`** on the file (or on its directory) and fix what
   it reports, first error first. Read each message to its end: where the compiler knows the
   fix, the last sentence is it (`Unknown function "lerp". HLSL's lerp is mix here.`). `check`
   also takes `source`, to try text before writing it.
2. **Look names up instead of guessing.** GLSL and HLSL names mostly do not exist here (`lerp`,
   `texture`, `inversesqrt`, `float3`). `docs` with a name returns TypeShade's name for it and
   every overload; `docs` with no name lists the whole vocabulary.
3. **Run the code when the numbers matter.** `run` executes a helper (`args`) or an entry point
   (`invocation` keyed by `@builtin` id, `bindings` for uniforms) on the CPU at f32, and
   `breakpoints` lists every local at chosen lines. It is the fastest way to find a sign error.
4. **`compile`** shows the WGSL, the GLSL, and the reflection (bind groups, uniform byte
   offsets) the host needs.

Lines and columns are 1-based everywhere; the navigation tools take `{ "line": 12, "symbol":
"tint" }` instead of a column. If the MCP tools are not connected, compile with the project's own
build, or with the snippet in [references/host.md](references/host.md).

## A complete shader

A mesh pipeline: vertex attributes, a uniform struct, and one output class shared by both stages.

```ts
"use typeshade"

class Frame {
  mvp: mat4
  time: f32
}

declare const frame: uniform<Frame>

class VsIn {
  @location(0) pos: vec3
  @location(1) color: vec3
}

class VsOut {
  @builtin("position") pos: vec4
  @location(0) color: vec3
}

@vertex
export function vs(v: VsIn): VsOut {
  return { pos: frame.mvp * vec4(v.pos, 1.), color: v.color }
}

@fragment
export function fs(v: VsOut): vec4 {
  const pulse = 0.5 + 0.5 * sin(frame.time)
  return vec4(v.color * pulse, 1.)
}
```

A compute kernel over storage buffers (WGSL only: GLSL ES 3.00 has no compute stage):

```ts
"use typeshade"

class Params {
  a: f32
  n: u32
}

declare const params: uniform<Params>
declare const x: storage<array<f32>>
declare const y: storage<array<f32>, "read_write">

@compute([64])
export function saxpy(@builtin("global_invocation_id") gid: vec3u): void {
  const i = gid.x
  if (i >= params.n || i >= y.length) {
    return
  }
  y[i] = params.a * x[i] + y[i]
}
```

More complete examples (a fullscreen pass, textures and overrides, a workgroup reduction) are in
[references/examples.md](references/examples.md).

## The rules an agent gets wrong

**1. Numbers have a width, and literals follow the declaration.** Write every float with a dot
(`1.`, `0.5`). An integer-written literal takes an integer type only where one is declared (an
annotation, a parameter, the other operand, an index, a `for` initializer); where nothing
declares a type it is an `f32` today. So annotate integer locals:

<!-- expect: TS8003 -->

```ts
"use typeshade"
export function pick(xs: array<f32, 4>): f32 {
  let i = 0
  return xs[i]
}
```

```ts
"use typeshade"
export function pick(xs: array<f32, 4>): f32 {
  let i: i32 = 0
  return xs[i]
}
```

There is no implicit conversion: `f32 + i32` and `u32 + i32` are `TS8003`. Cast with `f32(i)`,
`i32(x)`, `u32(x)`, and convert vectors with their constructors (`vec3(v3u)`, `vec2i(p)`).

**2. Operators broadcast a scalar; builtin functions do not.** `v * 2.` and `v + 1.` are fine.
`max(v, 0.)`, `clamp(v, 0., 1.)`, `step(0.5, v)` and `pow(v, 2.)` are `TS8036`: splat the scalar.
`mix(a, b, t)` is the exception and takes a scalar `t`.

<!-- expect: TS8036 -->

```ts
"use typeshade"
export function tone(c: vec3): vec3 {
  return pow(max(c, 0.), 2.2)
}
```

```ts
"use typeshade"
export function tone(c: vec3): vec3 {
  return pow(max(c, vec3(0.)), vec3(2.2))
}
```

**3. Loops are counted, and the bound can be data.** A `for` steps an integer by a constant toward
a bound: a literal, a `const`, a parameter, a uniform field or `xs.length`, with no limit on the
trips. `for (let i = 0; i < data.length; i++)` works as written (the counter takes the bound's
`u32`). The step must move toward the bound and the body must not write it (`TS8006`, `TS8007`).
`for (const x of xs)` iterates an array. A `while` tests anything; `while (true)` needs a `break`
or a `return` in its body (`TS8007`). `do...while` and labels are refused.

```ts
"use typeshade"
export function march(steps: i32, dt: f32): f32 {
  let t = 0.
  for (let i = 0; i < steps; i++) {
    t += dt
  }
  return t
}
```

**4. Annotate every parameter, and the return type of an entry.** A helper's return type is
inferred from its first `return` with a value (none without one); an entry (`@vertex`,
`@fragment`, `@compute`) that returns a value without an annotation is `TS8021`.

**5. Parameters are immutable** (`TS8018`): copy one into a `let` to change it. A swizzle is
written one component at a time (`v.x = 1.`; `v.xy = ...` is `TS8018`).

**6. There are no strings, no `==`, no JavaScript runtime.** Use `===` and `!==`. `console.log`
takes values and string-literal labels (`console.log("x =", x)`); a template with a value in it
is refused. A CPU run hands each call to the host's sink, and a compile with `console: 'gpu'`
records it on WebGPU too, for `decodeConsole` to read back as the same lines. `Math.random()` is refused; `random(seed)`
is a hash. No `var`, `try`, `async`, `number`, `boolean`, `T[]` or `any`. Of the JavaScript
array methods, `map`, `forEach`, `some`, `every` and `reduce` compile (`map` only on a fixed-size
array); `filter`, `find` and the rest are `TS8099`, and the answer is a loop. Functions are written as TypeScript writes them: a nested `function` or
an arrow constant may read and write the locals around it, and a function may take a function
(`apply(sq, x)`, an arrow as an argument). Recursion is refused (`TS8031`).

**7. Resources are declared, and numbered for you.** Every `declare` resource is `@group(0)`,
bound in declaration order; `compile` with the reflection target prints the slots. The
compiler adds its own after yours: `_fp64` for emulated doubles, and `_console` under
`console: 'gpu'`. Make a
uniform's type a struct, or the GLSL output is dropped with a `TS8015` warning.

**8. Stage input and output are explicit.** Builtins are parameters (`@builtin("position") p:
vec4`); there are no implicit globals. An IO struct is a `class` whose every field has
`@location(n)` or `@builtin(...)`. Share one output class between the vertex and fragment
stages: GLSL links varyings by name. `@compute([x])` is one-dimensional (`[8, 8]` is `TS8026`).
Keep one `@vertex` and one `@fragment` per file when WebGL2 matters.

**9. Fragment-only operations stay out of divergent branches.** `textureSample`, `dpdx`,
`dpdy` and `fwidth` are fragment-only, and may not sit under a branch on a per-fragment value
(`TS8052`): sample before the branch, or use `textureSampleLevel`. `discard` is a statement and
is fine under a branch.

**10. One file is one module.** The compiler's public `compile()` takes one file, and a call to
a function imported from another shader is `TS8004`. Keep each shader self-contained.

## Types and resources at a glance

| Write                                                               | Means                                                       |
| ------------------------------------------------------------------- | ----------------------------------------------------------- |
| `f32` `i32` `u32` `bool`                                            | scalars (`number` and `boolean` are refused)                |
| `vec2` `vec3` `vec4`, `vec3i`, `vec3u`, `vec3b`                     | vectors of f32, i32, u32, bool                              |
| `mat4`, `mat3`, `mat2x3` ...                                        | column-major matrices; `m * v` is the column-vector product |
| `array<f32, 16>`, `array<f32>`                                      | fixed-size array; runtime-sized only in storage             |
| `class P { a: f32 }`, `interface`, `type P = {...}`                 | a struct; `new`, methods and getters work on classes        |
| `declare const u: uniform<P>`                                       | uniform buffer                                              |
| `declare const s: storage<array<f32>>` / `storage<T, "read_write">` | read-only / read-write storage buffer                       |
| `declare const tex: texture_2d<f32>`, `declare const smp: sampler`  | a texture and a sampler                                     |
| `const k: override<f32> = 1.`                                       | pipeline override (not a compile-time constant)             |
| `let tile: workgroup<array<f32, 64>>`                               | workgroup memory, compute only                              |

The full rules (casts, structs and classes, layouts, textures, atomics, uniformity, reserved
names) are in [references/language.md](references/language.md).

## Coming from GLSL or HLSL

<!-- names: foreign to typeshade -->

| GLSL or HLSL                  | TypeShade                          |
| ----------------------------- | ---------------------------------- |
| `lerp`                        | `mix`                              |
| `frac`                        | `fract`                            |
| `inversesqrt`, `rsqrt`        | `inverseSqrt`                      |
| `texture`, `texture2D`        | `textureSample`                    |
| `textureLod`                  | `textureSampleLevel`               |
| `texelFetch`                  | `textureLoad`                      |
| `textureSize`                 | `textureDimensions`                |
| `dFdx`, `ddx`                 | `dpdx`                             |
| `float3`                      | `vec3`                             |
| `ivec2`, `int2`               | `vec2i`                            |
| `uvec3`, `uint3`              | `vec3u`                            |
| `gl_FragCoord`, `SV_Position` | `@builtin("position")`             |
| `gl_VertexID`, `SV_VertexID`  | `@builtin("vertex_index")`         |
| `gl_GlobalInvocationID`       | `@builtin("global_invocation_id")` |
| `shared`, `groupshared`       | `workgroup`                        |
| `barrier()`                   | `workgroupBarrier`                 |
| `floatBitsToUint`, `asuint`   | `bitcast`                          |

`fmod` is the `%` operator (truncating); `mod()` floors like GLSL's. `mul(m, v)` is `m * v`.
`select(f, t, cond)` takes the condition last, as in WGSL. `docs` translates any of these.

## Diagnostics

`TS8xxx` codes are TypeShade's; plain TypeScript codes (`TS2304`) come from TypeScript's checker,
which still runs, with its false positives on shader code filtered out. The ones met most often:

| Code   | Usual cause                                                                 | Fix                                                    |
| ------ | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| TS8002 | `number`, `boolean`, `T[]`, or an unannotated parameter                     | a shader type, annotated                               |
| TS8003 | mixed `f32`/`i32`, an f32 index, a non-bool `if`, mismatched vector sizes   | cast explicitly; annotate integer locals               |
| TS8004 | a call to a name TypeShade does not have (`lerp`, an imported helper)       | `docs` for the TypeShade name                          |
| TS8006 | a loop bound the body writes, or `!=` against a runtime bound               | read the bound into a `const`; compare with `<`        |
| TS8015 | an emitter refused the module (a warning drops the GLSL only)               | read the message: often a uniform that is not a struct |
| TS8018 | a write to a parameter or to a multi-component swizzle                      | copy into a `let`; write one component                 |
| TS8021 | an entry that returns a value with no return annotation                     | annotate it                                            |
| TS8022 | an unknown name, field or swizzle; a name read before its declaration       | the name the message suggests; declare before use      |
| TS8036 | a scalar beside a vector in a builtin (`max(v, 0.)`)                        | splat: `max(v, vec3(0.))`                              |
| TS8052 | `textureSample` or a derivative under a per-fragment branch                 | sample before branching                                |
| TS8099 | a string, `==`, `do...while`, `xs.filter(...)`, `declare let` on a resource | read the message: it names the construct               |

Every code, with its causes, is in [references/diagnostics.md](references/diagnostics.md).

## The host side

Import the module, with `typeshade()` from `typeshade/vite` in the Vite config:

```ts
import { height } from './terrain.shade.ts'
import { scale } from './kernels.shade.ts'

const h = height([0.5, 0.5], k) // a helper runs on the CPU, synchronously, at f32
await scale({ k: 2.5, xs, ys }, 4) // a @compute entry dispatches on WebGPU; ys is filled in place
```

A vector is a tuple of numbers, a struct an object of its fields. `tsc` reads a generated host
view, `terrain.shade.typeshade.ts`, through `"moduleSuffixes": [".typeshade", ""]` and an
`exclude` of the shader sources; `typeshade sync` writes the views. Or compile the file and wire
the output yourself:

```ts
import { compile, reflect } from 'typeshade'

const result = compile(source, { fileName: 'tint.shade.ts' })
// result.wgsl is undefined when any diagnostic is an error.
// result.glsl is { vertex, fragment }, or undefined for compute or WGSL-only modules.
const layout = reflect(result.module) // bind groups, uniform offsets, entry points
```

Pack uniform buffers at the offsets `reflect` reports, never by hand: a `vec3` aligns to 16
bytes. The import, WebGPU, WebGL2 and the editor setup are in [references/host.md](references/host.md).
