---
name: typeshade
description: Write, fix and review TypeShade shaders, which are TypeScript files that start with the "use typeshade" directive and compile to WGSL and GLSL ES 3.00. Use when creating or editing a .shade.ts or "use typeshade" file, porting a GLSL, HLSL or WGSL shader to TypeShade, wiring TypeShade output into WebGPU or WebGL2 host code, importing a .shade.ts into a host file through typeshade/vite, or reading TypeShade diagnostics (TS8001 to TS8099). Covers the rules that differ from both TypeScript and GLSL, the common diagnostics and their fixes, and the typeshade MCP tools (check, compile, docs, run).
---

# TypeShade

TypeShade is a shader language written as TypeScript. A file whose first line is
`"use typeshade"` is a shader module: the compiler lowers it, with the shader modules it imports,
to WGSL for WebGPU and, where a form exists, to GLSL ES 3.00 for WebGL2. A host uses it one of two
ways: it compiles the file and builds its own pipelines from the emitted text, or, through the
`typeshade/vite` plugin, it imports the `.shade.ts` and calls its exports, a helper on the CPU and
a `@compute` or full-screen `@fragment` entry on the GPU.

The file looks like TypeScript and is not checked like TypeScript. **The TypeShade compiler
decides what is valid.** Plain `tsc` or a plain TypeScript language server reports errors on
shader files that are not errors (vector arithmetic such as `a + b` on two `vec3`, the stage
attributes `@vertex`, `@fragment` and `@compute`); do not "fix" those. And it misses real ones (an integer used as an index, a
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
   (`invocation` keyed by builtin id, `bindings` for uniforms) on the CPU at f32, and
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
  pos: vec3
  color: vec3
}

class VsOut {
  pos: builtin<"position">
  color: vec3
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
export function saxpy(gid: builtin<"global_invocation_id">): void {
  const i = gid.x
  if (i >= params.n || i >= y.length) {
    return
  }
  y[i] = params.a * x[i] + y[i]
}
```

A loop over an array needs no entry at all. An exported function that takes an array with no
size is a kernel function. When the compiler proves, for each `for` at the top of its body, that
no iteration touches what another does, each loop runs on the GPU, one invocation per iteration.
When it cannot prove one, the whole function runs on the CPU, with a `TS8070` warning that names
the line and the fix. The array is the caller's, written in place:

```ts
"use typeshade"

export function multiply(k: f32, xs: array<f32>, ys: array<f32>) {
  for (let i: u32 = 0; i < xs.length; i++) {
    ys[i] = xs[i] * k
  }
}
```

A host can run a chain of kernel-function calls as one dispatch, inside `fuse` (see The host side).
To let a call join the calls before it, write one `for` loop in the function. Write and read each
array that two calls share at the loop's counter alone: `t[i]`, not `t[i - 1]` or `t[2 * i]`. A
call that cannot join runs as a dispatch of its own, with the same results.

More complete examples (a fullscreen pass, textures and overrides, a workgroup reduction) are in
[references/examples.md](references/examples.md).

## The rules an agent gets wrong

**1. Numbers have a width, and a written number takes its type from its uses.** Write a float
with a dot (`1.`, `0.5`) when you mean one. An integer-written literal, and an unannotated local
or constant it initializes, takes its type from every place it reaches: an annotation, a
parameter, a typed operand beside it, a field, an index (`i32` unless a use says `u32`). So
`let i = 0; xs[i]` works. Uses that demand two types are `TS8003`, and so is a `/` whose integer
operands all got their type by inference: annotate the value (`let k: u32 = 7`) or convert it.
There is no implicit conversion between declared types:

<!-- expect: TS8003 -->

```ts
"use typeshade"
export function scale(n: i32, x: f32): f32 {
  return x * n
}
```

```ts
"use typeshade"
export function scale(n: i32, x: f32): f32 {
  return x * f32(n)
}
```

`f32 + i32` and `u32 + i32` are `TS8003`. Cast with `f32(i)`,
`i32(x)`, `u32(x)`, and convert vectors with their constructors (`vec3(v3u)`, `vec2i(p)`).

**2. Operators broadcast a scalar; builtin functions do not.** `v * 2.` and `v + 1.` are fine.
`clamp(v, 0., 1.)` and `step(0.5, v)` are `TS8036`: splat the scalar. `max`, `min` and
`mix(a, b, t)` take a scalar beside a vector. A power is `a ** b` with both sides of one type:
`pow` is removed.

<!-- expect: TS8036 -->

```ts
"use typeshade"
export function tone(c: vec3): vec3 {
  return clamp(c, 0., 1.) ** vec3(2.2)
}
```

```ts
"use typeshade"
export function tone(c: vec3): vec3 {
  return clamp(c, vec3(0.), vec3(1.)) ** vec3(2.2)
}
```

**3. A `for` loop means what it means in TypeScript, and the bound can be data.** Any `for`
compiles: a float counter, two counters, no condition with a `break`. A `for` that steps an
integer by a constant toward a bound (a literal, a `const`, a parameter, a uniform field or
`xs.length`) is counted, and `for (let i = 0; i < data.length; i++)` works as written (the counter
takes the bound's `u32`). Any other `for` runs as a `while` does. A loop the compiler proves never
ends is refused: no condition and no `break` or `return`, or a constant step that never reaches
the bound (`TS8007`); a constant header that leaves its counter's type is `TS8006`. In a kernel
function, only a counted loop can run on the GPU. `for (const x of xs)` iterates an array.
`do...while` and labels are refused.

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

**4. Annotate every parameter.** A function's return type, an entry's included, is inferred
from its body. An entry writes its return type only where the body cannot say it: another
built-in value (`builtin<"frag_depth", f32>`) or an option on its output.

**5. An object is a reference; a number, a vector and a matrix are values.** As in JavaScript, a
struct, a class instance or an array passed to a function is the caller's object: a write to
`p.pos` or `xs[i]` in the callee changes it. A number, a `bool`, a vector or a matrix parameter is
a value: a whole write (`x = 0.`) changes a local copy, and a write into one (`v.x = 1.`) is
`TS8018`. To give back more than one value, return a tuple and destructure it:
`[a, b] = order(a, b)`. `@inout` and `@out` are removed (`TS8073`). A swizzle of a local is a
place: `d.xy *= d.yx` reads every old component before it writes one; a repeated component
(`d.xx = r`) is `TS8018`.

```ts
"use typeshade"

class Particle {
  pos: vec2
  vel: vec2
}

function nudge(p: Particle, dt: f32): void {
  p.pos += p.vel * dt
}

function order(lo: f32, hi: f32): [f32, f32] {
  return lo > hi ? [hi, lo] : [lo, hi]
}

export function demo(): f32 {
  const [lo, hi] = order(2., 1.)
  let p = new Particle()
  p.vel = vec2(1., 0.)
  nudge(p, 0.5)
  p.pos.yx *= vec2(2., 3.)
  return lo + hi + p.pos.x
}
```

**6. There are no strings, no `==`, no JavaScript runtime.** Use `===` and `!==`. `console.log`
takes values and string-literal labels (`console.log("x =", x)`); a template with a value in it
is refused, and `console.table(x)` takes one value. `log`, `info`, `debug`, `warn`, `error`
and `table` are the whole console. A CPU run hands each call to the host's sink, and a compile
with `console: 'gpu'` records it on WebGPU too, for `decodeConsole` to read back as the same
lines. `Math.random()` is refused; `random(seed)`
is a hash. No `var`, `try`, `async`, `number`, `boolean`, `T[]` or `any`. Of the JavaScript
array methods, `map`, `forEach`, `some`, `every` and `reduce` compile (`map` only on a fixed-size
array); `filter`, `find` and the rest are `TS8099`, and the answer is a loop. Functions are written as TypeScript writes them: a nested `function` or
an arrow constant may read and write the locals around it, and a function may take a function
(`apply(sq, x)`, an arrow as an argument). Recursion is refused (`TS8031`).

**7. Resources are declared, and numbered for you.** Every `declare` resource is `@group(0)`,
bound in declaration order, the compiled file's own before those of the files it imports;
`compile` with the reflection target prints the slots. The compiler adds its own after yours:
`_fp64` for emulated doubles, and `_console` under `console: 'gpu'`. A uniform may be a struct
or a bare scalar, vector or matrix (`uniform<f32>`); both reach GLSL.

**8. Stage input and output are typed.** A builtin is a parameter or a field whose type names
it, `p: builtin<"position">`, and WGSL gives its type; there are no implicit globals. Every other
input or output is user-defined, and the compiler numbers its location; write
`location<n, T>` only to fix a number or state an option. Share one output class between the
vertex and fragment stages: a value between stages is linked by its name. `@compute([x, y, z])` takes one to three dimensions;
omitted dimensions are 1, so `[8, 8]` is a two-dimensional workgroup.
Its dimensions may use a named constant or `override<u32>`; the same override may size the outer
array of a `workgroup` array. A host selects it with `program.compute(entry, { constants })`
or an imported entry's third argument, `entry(bindings, groups, { constants })`, including
inside `device.fuse()`. Calculate `groups` for the selected shape. WebGL2 requires the default
workgroup shape and array lengths; [references/host.md](references/host.md) has the complete example.
Keep one `@vertex` and one `@fragment` per file when WebGL2 matters.

**9. Fragment-only operations stay out of divergent branches.** `textureSample`, `dpdx`,
`dpdy` and `fwidth` are fragment-only, and may not sit under a branch on a per-fragment value
(`TS8052`): sample before the branch, or use `textureSampleLevel`. `discard` is a statement and
is fine under a branch.

**10. A shader file imports what another exports.** A TypeScript import with a relative path,
`import { fbm, Light } from "./noise.shade.ts"`, takes what another `"use typeshade"` file
exports: a function, a struct, an enum, a constant, a binding, anything declared at its top
level. A shader library installed with npm is imported by its name, `import { fbm } from
"shade-noise"`: the compiler finds it in `node_modules` and reads the file its `package.json`
publishes under the `typeshade` condition of `exports`. The file you compile and the files it
imports are one program, emitted as one module, and an imported file's own entry points stay out
of it. An import the compiler does not follow (a wrong path, a plain `.ts` file, a package that
is not installed or does not export the path, a name the file does not export, a default import)
is `TS8072`. `compile()` reads the imported files, and each package's `package.json`, through
the `readDocument` you pass it ([references/host.md](references/host.md));
[references/language.md](references/language.md) has a two-file example and a package's
`exports`.

**11. `mouse` is already 0 to 1; do not divide it by `resolution`.** The Playground and the
editor's canvas fill the uniform struct's `time` (seconds), `resolution` (pixels) and
`mouse: vec2` (the pointer over the canvas from 0 to 1, origin at the bottom left: the space
`uv` is in). Use `u.mouse` as it is; `u.mouse * u.resolution` is the pointer in pixels.
ShaderToy's `iMouse.xy / iResolution.xy` does not carry over: it shrinks the pointer to nearly 0.
An untouched canvas holds `(0.5, 0.5)`, not 0, so `if (u.mouse.x > 0.)` is always true; read
the pointer as an offset from the centre (`u.mouse - vec2(0.5)`) so the untouched frame is the
default view.

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
| `let tile: workgroup<array<f32, WG_SIZE>>`                          | workgroup memory sized by an integer constant or override   |

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
which still runs, with its false positives on shader code filtered out. A read of a variable
before it is assigned is the compiler's `TS8075` where TypeScript reported TS2454. The ones met
most often:

| Code   | Usual cause                                                                                                                 | Fix                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| TS8002 | `number`, `boolean`, `T[]`, or an unannotated parameter                                                                     | a shader type, annotated                                               |
| TS8003 | mixed `f32`/`i32`, an f32 index, a non-bool `if`, mismatched vector sizes                                                   | cast explicitly; annotate integer locals                               |
| TS8004 | a call to a name not declared or imported (`lerp`, another file's helper)                                                   | `docs` for the TypeShade name; import the helper                       |
| TS8006 | a constant loop header that walks its counter out of its type's range                                                       | fix the bound or the counter's type                                    |
| TS8015 | an emitter refused the module (a warning drops the GLSL only)                                                               | read the message: it names what the target has no form for             |
| TS8018 | a write into a vector or number parameter (`v.x = 1.`); a swizzle target that repeats a component (`v.xx = r`)              | copy into a `let`, or return the value; name each component once       |
| TS8021 | a bare `return` where a value is required                                                                                   | return a value                                                         |
| TS8022 | an unknown name, field or swizzle; a name read before its declaration                                                       | the name the message suggests; declare before use                      |
| TS8036 | a scalar beside a vector in a builtin (`clamp(v, 0., 1.)`)                                                                  | splat: `clamp(v, vec3(0.), vec3(1.))`                                  |
| TS8052 | `textureSample` or a derivative under a per-fragment branch                                                                 | sample before branching                                                |
| TS8072 | an import not followed: a wrong path, a plain `.ts` file, a package not installed or not exporting the path, no such export | a path to a shader file, or one the package exports; `export` the name |
| TS8073 | an `@inout` or `@out` qualifier, which is removed                                                                           | delete it; return a number or a vector, `[a, b] = f(a, b)` for two     |
| TS8075 | a variable read before it is assigned on every path                                                                         | assign it first, or declare it with a value                            |
| TS8099 | a string, `==`, `do...while`, `xs.filter(...)`, `declare let` on a resource                                                 | read the message: it names the construct                               |

Every code, with its causes, is in [references/diagnostics.md](references/diagnostics.md).

## The host side

Import the module, with `typeshade()` from `typeshade/vite` in the Vite config:

```ts
import { height, render } from './terrain.shade.ts'
import { scale } from './kernels.shade.ts'
import { fs } from './plasma.shade.ts'

const h = height([0.5, 0.5], k) // a helper runs on the CPU, synchronously, at f32
await render(k, 512, img) // a kernel function: each loop it proves runs on the GPU; img is filled in place
await scale({ k: 2.5, xs, ys }, 4) // a @compute entry dispatches on WebGPU; ys is filled in place
fs(canvas, { frame: { time, scale: 0.02 } }) // a full-screen @fragment entry draws one frame
```

A vector is a tuple of numbers, a struct an object of its fields, a kernel function's array a
typed array, and an entry's bindings object has one property for each binding the entry reaches. `tsc` reads a generated host view,
`terrain.shade.typeshade.ts`, through `"moduleSuffixes": [".typeshade", ""]` and an `exclude` of
the shader sources. `tshc sync` writes the views.

A host that calls several kernel functions over the same arrays can run the chain as one plan with
`fuse` from `typeshade/fuse`. The body is synchronous, and every array that a call in it writes is a
`Buffer`, made by `array()` or `zeros()` from `typeshade/runtime`. `scope.scratch(n)` makes a
scratch array, an intermediate that the host never reads:

```ts
import { array } from 'typeshade/runtime'
import { fuse } from 'typeshade/fuse'
import { add, mul, relu } from './ops.shade.ts' // kernel functions with one loop each

const a = array(xs) // xs, ys and zs are Float32Array of n elements
const b = array(ys)
const c = array(zs)
const out = array(n, 'f32') // zeros, with no upload
const report = await fuse((scope) => {
  const t = scope.scratch(n)
  const u = scope.scratch(n)
  add(t, a, b)
  mul(u, t, c)
  relu(out, u)
})
report.dispatches // 1 on WebGPU: the three loops are one dispatch
const y = await out.read() // relu((a + b) * c)
```

- **Keep the fusion facts.** `typeshade()` in `vite.config.ts` writes them by default.
  `typeshade({ fuse: false })` leaves them out: the calls still work, but they run apart, and the
  report says why.
- **Write each function for it.** A call joins the group before it when its loop runs over the same
  range as theirs, an array that a call in the group wrote is written and read at the loop's counter
  alone (`t[i]`), and it writes no array that a call in the group reads or writes. Otherwise it
  stands apart, as a dispatch of its own, with the same results. A second loop, a `continue` and a
  scatter keep a function from joining too.
- **End a chain with a reduction** when you need a sum: `sum = total(u)` in the body, and
  `await sum` after `fuse`. The reduction takes the calls before it into its loop. Nothing joins
  after it.
- **Read the report.** `report.groups` lists the groups, each with its `calls`, whether it is
  `fused`, the `tier` it ran on and its `dispatches`. A group that stands apart has a `why` in
  your names:
  ``mul and blur run as two dispatches because blur reads `t[i - 1]` (line 9)``.
- **Only WebGPU fuses.** WebGL2 runs the calls apart, and the CPU tier never fuses. The results are
  the same on every tier.
- **Keep other calls out of the body.** `read()`, `write()` and `destroy()` of a `Buffer`, a call
  that writes a typed array, an entry call and a draw throw a `TypeError` inside it, and the message
  names the call. Put them outside `fuse`. An `async` body is a `TypeError` too.
- **The host never reads a scratch array.** `read()` and `write()` of one are a `TypeError`. Make the
  array with `array()` or `zeros()` when the host reads it after the scope.

To compile the file and wire the output yourself instead:

```ts
import { compile, reflect } from 'typeshade'

// readDocument(path) returns a file's text, or undefined: how the compiler reads what tint imports.
const result = compile(source, { fileName: 'src/tint.shade.ts', readDocument })
// result.wgsl is undefined when any diagnostic is an error.
// result.glsl is { vertex, fragment }, or undefined for compute or WGSL-only modules.
const layout = reflect(result.module) // bind groups, uniform offsets, entry points
```

Pack uniform buffers at the offsets `reflect` reports, never by hand: a `vec3` aligns to 16
bytes. The import, `fuse`, the program runtime, WebGPU, WebGL2 and the editor setup are in
[references/host.md](references/host.md).
