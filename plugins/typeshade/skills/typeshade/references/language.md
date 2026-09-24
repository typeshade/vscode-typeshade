# The TypeShade language, in full

What `SKILL.md` summarises, with the rest of the rules. Section numbers (§N) are those of the
compiler's normative surface, `docs/use-typeshade-surface.md` in `typeshade/typeshade`.

## The file

- The file starts with `"use typeshade"`. Without it, the whole result is one `TS8001`.
- The top level holds: functions; `class`, `interface` and `type` declarations; numeric `enum`
  and `const enum`; `namespace`; module constants (`const K: f32 = 2.`); overrides
  (`const q: override<f32> = 1.`); resources (`declare const`); module variables
  (a top-level `let`); `"enable <extension>"` directives; `import` and `export`.
- Refused at the top level: an expression or an `if` (`TS8014`), `var` (`TS8014` and `TS8013`),
  `declare function` (`TS8020`).
- `export` is conventional on entries and helpers and not required.
- `import` between shader files parses and binds nothing in `compile()`: a call to an imported
  function is `TS8004`. Keep a shader in one file and copy helpers.
- `"enable subgroups"` (also `f16`, `clip_distances`, `dual_source_blending`,
  `primitive_index`) goes after the file directive (§50); a builtin that needs an extension
  enables it by itself.

## Types

| Kind            | Spellings                                                                                                                                                             | Notes                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| scalars         | `f32` `i32` `u32` `bool`                                                                                                                                              | `number`, `boolean`, `string`, `any` are `TS8002`                          |
| emulated double | `f64`, `vec2f64` `vec3f64` `vec4f64` (also `vec2d` ...)                                                                                                               | two f32s; a few operations only; never on stage input or output (`TS8038`) |
| float vectors   | `vec2` `vec3` `vec4`, the same as `vec2f` ..., `vec3<f32>`                                                                                                            |                                                                            |
| other vectors   | `vec2i` ... `vec4i`, `vec2u` ... `vec4u`, `vec2b` ... `vec4b`                                                                                                         | a `vecNb` is what comparing two vectors gives                              |
| matrices        | `mat2` `mat3` `mat4`, every `matCxR` (`mat2x3`, `mat4x3` ...) and WGSL's `matCxRf` aliases (`mat4x4f`)                                                                | column-major: `m[j]` is column `j`                                         |
| arrays          | `array<T, N>`; `array<T>` runtime-sized, storage only                                                                                                                 | `T[]` is `TS8002`; an array of arrays is refused, so flatten               |
| tuples          | `[f32, f32]` is `array<f32, 2>`                                                                                                                                       | a mixed tuple is refused: declare a struct                                 |
| structs         | `class`, `interface`, `type X = { ... }`                                                                                                                              | the same struct; only class fields carry `@location` and `@builtin`        |
| enums           | numeric `enum`, `const enum`                                                                                                                                          | members are `i32` constants; a string member is `TS8003`                   |
| aliases         | `type Meters = f32`                                                                                                                                                   |                                                                            |
| handles         | `texture_2d<f32>`, `texture_2d_array`, `texture_cube`, `texture_3d`, `texture_depth_2d`, `sampler`, `sampler_comparison`, `texture_storage_2d<"rgba8unorm", "write">` | declared bare and `const`                                                  |

### Literals

- A float is written with a dot: `1.`, `0.5`.
- An integer-written literal takes an integer type where one is declared: an annotation, a
  parameter, a return type, a struct field, an element of `vec3u(...)` or of an annotated list,
  the other operand of an integer operator, an index. `let n: u32 = 7` and `gid.x < 100` are
  fine.
- Where nothing declares a type, an integer-written literal is an `f32` today: `let i = 0` is an
  f32, and `xs[i]` is then `TS8003`. A `for` initializer is the exception (`for (let i = 0; ...)`
  is an `i32`). The default will change to `i32`; `compile(src, { deprecations: true })` warns
  about each such literal as `TS8053`.
- An integer array is written as an annotated list, `const w: array<i32, 3> = [1, 2, 1]`.

### Conversions

- Scalars: `f32(x)`, `i32(x)`, `u32(x)`, `bool(x)`, `f64(x)`. A float to an integer truncates
  toward zero; GLSL leaves an out-of-range value undefined, so clamp first. `u32(i)` and
  `i32(u)` reinterpret the bits.
- Vectors: through the constructor, `vec3(v3u)`, `vec3u(v)`, `vec2i(p)`, `vec2(gid.xy)`. The sizes
  must match. `f32(v)` on a vector is `TS8003`.
- Constructors: `vec3(0.5)` splats; `vec4(v3, 1.)` and `vec4(v2, v2)` compose; `vec3()` is zero;
  `vec3<u32>(1, 2, 3)` names the element type; `array(1., 2., 3.)` is an `array<f32, 3>`;
  `mat3(m4)` truncates; `mat3(c0, c1, c2)` builds from columns.
- `x as T` is a claim to the type checker, not a conversion, and emits nothing.
- `bitcast<u32>(x)` reinterprets the bits of an `f32`, and `bitcast<f32>(u)` the reverse.

```ts
"use typeshade"

enum Mode {
  Flat,
  Shaded,
}

interface Light {
  dir: vec3
  power: f32
}

const TILES: u32 = 8
const PALETTE: array<vec3, 2> = [vec3(1., 0.5, 0.), vec3(0., 0.5, 1.)]

export function shade(n: vec3, l: Light, mode: Mode, id: u32): vec3 {
  const k = max(dot(n, -l.dir), 0.) * l.power
  const tile = id % TILES
  const base = PALETTE[i32(tile & 1)]
  return mode === Mode.Flat ? base : base * k
}
```

## Structs and classes

- An object literal takes its struct from the context: the return type, an annotated `const`,
  a parameter, an assignment target. Shorthand `{ pos, uv }` and spread `{ ...p, y: 9. }` work.
- A missing, extra or optional field is `TS8010`. Two declarations of one name are `TS8023`,
  interfaces included (TypeScript would merge them; TypeShade does not).
- Assigning or passing a struct copies it.
- Classes have methods, a constructor, static members, getters and setters, `#private` members,
  parameter properties and `readonly`, and are built with `new` (§26). A method that assigns to
  `this` needs a `let` receiver (`TS8035` on a `const`). Generic functions and classes are
  compiled once per type used (§30, §32). `namespace N { export function f() }` becomes `N_f`.
- Field attributes: `@location(n)`, `@builtin("...")`, `@interpolate("flat")` or
  `@interpolate("perspective", "centroid")`, `@invariant`, `@blend_src`. `@align`, `@size` and
  `@offset` are refused: the compiler lays out buffers itself.

## Resources

- `declare const u: uniform<T>`: a uniform buffer. Make `T` a struct: a bare `uniform<f32>` is
  valid WGSL, and the GLSL emitter refuses it (a `TS8015` warning that drops the GLSL).
- `declare const s: storage<T>` is read-only storage; `declare const s: storage<T, "read_write">`
  is read-write. The access mode is the second type argument, `"read"` (the default) or
  `"read_write"`. Every resource is `declare const`: `declare let` on one is `TS8099`, which names
  the line to write. Writing a read-only resource is `TS8005` in the compiler and `TS2542` or
  `TS2540` in the editor.
- `declare const tex: texture_2d<f32>` and `declare const smp: sampler`: handles, bare and
  `const`.
- `const q: override<f32> = 0.5`: a pipeline override, scalar only, set by the host at pipeline
  creation. It takes no binding slot and is not a compile-time constant, so it cannot bound a
  loop.
- `let seed: u32 = 7` at the top level: a per-invocation module variable.
- `let tile: workgroup<array<f32, 64>>`: workgroup memory, with no initializer, compute only.
- `declare const bins: storage<array<atomic<u32>>, "read_write">`: atomics (`atomic<u32>` or `atomic<i32>`), in
  read-write storage only, used through `atomicAdd(bins[i], 1)` and the other atomic builtins.
- **Slots.** Every `declare` resource is `@group(0)`, numbered `@binding(0)`, `@binding(1)` ...
  in declaration order, textures and samplers included; overrides and module variables take no
  slot. There is no syntax to choose a slot. Read them from the reflection. The compiler's own
  bindings come after yours: `_fp64` when emulated doubles need it, and `_console` under
  `compile(src, { console: 'gpu' })`.
- **Runtime-sized arrays.** `array<T>` only as a storage binding or the last field of a storage
  struct. Its `.length` (or `arrayLength(xs)`) is a runtime `u32`; on anything not in storage
  it is `TS8032`.
- **Layout.** A `bool` field in a buffer struct is `TS8051` (use `u32`). `mat2`, `mat3x2` and
  `mat4x2` in a uniform drop the GLSL, since std140 and WGSL lay a two-row matrix out
  differently; use `mat2x4` or two `vec2`s. `array<f32, N>` in a uniform struct is padded to 16
  bytes per element for you. Host code packs buffers at the offsets the reflection reports.
- **What leaves GLSL out.** A read-write storage buffer, an atomic, workgroup memory, a storage
  texture or a compute entry makes the module WGSL-only. Read-only storage read in a render
  stage becomes a data texture in GLSL.

## Entry points

- `@vertex`, `@fragment`, `@compute` go on top-level functions. A function without one is a
  helper. Calling an entry is refused: move the body into a helper both call.
- `@compute([x])`: y and z must be 1 (`TS8026`), so linearise 2-D work over `gid.x`. A bare
  `@compute` is a workgroup of 64.
- **Builtins are parameters.** Vertex: `vertex_index: u32`, `instance_index: u32`. Vertex
  output and fragment input: `position: vec4`. Fragment: `front_facing: bool`,
  `sample_index: u32` and `sample_mask: u32` (both WGSL-only), `frag_depth: f32` (output).
  Compute: `global_invocation_id`, `local_invocation_id`, `workgroup_id`, `num_workgroups` (all
  `vec3u`), `local_invocation_index: u32`. An unknown id is `TS8024`, the wrong stage `TS8025`.
- **Stage IO.** Parameters can carry `@location(n)` directly (`fs(@location(0) uv: vec2)`), or be
  one IO struct: a `class` whose every field has `@location(n)` or `@builtin(...)` (`TS8029`).
  Integer varyings are `flat` automatically; a `bool` varying is refused. The vertex output and
  the fragment input at one location must have the same field name and type (`TS8010`): share
  one class.
- **Returns.** A vertex entry returns `vec4` (the position) or a struct with a
  `@builtin("position")` field. A fragment entry returns `f32` ... `vec4` (location 0), a struct of
  `@location(n)` fields (several render targets, optionally `@builtin("frag_depth")`), or
  `void`. A compute entry returns nothing. An entry that returns a value must annotate it.
- **Stage-only calls.** Fragment only: `discard`, `textureSample`, `textureSampleBias`,
  `textureSampleCompare`, `dpdx`, `dpdy`, `fwidth` and their variants, followed through helper
  calls. Fragment or compute: atomics and `textureStore`. Compute only: `workgroupBarrier()` and
  `storageBarrier()` (`TS8034`). `textureSampleLevel`, `textureSampleGrad` and `textureLoad`
  work in any stage.
- **Uniformity (§54).** `textureSample`, `textureSampleBias` and the derivatives may not sit
  under a branch on a per-fragment value, and an early `return` under such a branch counts
  (`TS8052`). Sample before the branch, use `textureSampleLevel`, or put
  `@diagnostic("off", "derivative_uniformity")` above the entry. A branch on a uniform value is
  fine. A barrier under a branch on an invocation id is `TS8052` too.
- **GLSL has one program per stage.** Keep one `@vertex` and one `@fragment` in a file that
  needs WebGL2. A compute entry beside them drops the GLSL.

## Functions and control flow

- Annotate every parameter. A helper's return type is inferred from its first `return` with a
  value; an entry that returns a value needs its annotation (`TS8021`).
- Parameters are immutable (`TS8018`). Default values work (`b: f32 = 0.8`) as long as they do
  not read another parameter; optional (`b?: f32`) and rest parameters are `TS8020`.
- `const` is immutable (`TS8005`), `let` is mutable. `let x: f32` without an initializer needs
  its annotation. Block scope and shadowing work.
- Destructuring a vector or a struct works (`const { x, y } = v`); an array pattern does not.
- A local function is a nested `function` or an arrow constant, and it may read and write the
  locals around it. A parameter may be a function (`h: (x: f32) => f32`), and an arrow may be
  written as the argument.
- Recursion, direct or mutual, is `TS8031`.
- A call alone on a line is fine; a value alone on a line (`vec3(1.)`) is refused.
- `if` needs a `bool` condition (`if (x)` on an `f32` is `TS8003`). The ternary works on any
  type. `select(f, t, cond)` puts the condition last, as WGSL does.
- `for`: an integer `let`, stepped by a constant (`++`, `--`, `+=`, `-=`, `*=`, `/=`) toward a
  bound. The start and the bound may be runtime values (a parameter, a uniform field,
  `xs.length`) and there is no limit on the trips. An unannotated counter starting at a
  non-negative literal takes the type of a `u32` bound. A bound the body writes, or `!=`
  against a runtime bound, is `TS8006`; a float induction variable is `TS8008`; a missing
  condition or a step away from the bound is `TS8007`.
- `for (const x of xs)` iterates an `array<T, N>` or a runtime-sized storage array.
- Five array methods run as TypeScript runs them, each lowered to a counted loop:
  `xs.forEach(f)`, `xs.some(p)`, `xs.every(p)`, `xs.reduce(f, init)` (or `xs.reduce(f)` on a
  non-empty fixed-size array), and `xs.map(f)`, which returns an `array<R, N>` and so takes a
  fixed-size array only. The function is a name, an arrow or a function expression written in
  the call, taking `(value, index, array)` with `index` an `i32`. `filter`, `find` and the rest
  are `TS8099`: an array's length is fixed, so they are a loop.
- `while` takes any `bool` condition; `while (true)` needs a `break` or a `return` in its body
  (`TS8007`). `do...while`, labels and `for...in` are refused.
- `switch` is on an integer, with integer constant labels (`TS8017` otherwise). A case body that
  would fall through into the next case is refused (`TS8017`), so end each case with `break`
  (the last one may leave it out); `case 0: case 1:` stacked above one body share it.

```ts
"use typeshade"

const MAX_STEPS: i32 = 64

class Params {
  steps: i32
  scale: f32
}

declare const params: uniform<Params>

function tier(k: i32): i32 {
  switch (k) {
    case 0:
    case 1:
      return 10
    case 2:
      return 20
    default:
      return 99
  }
}

function vignette(uv: vec2, strength: f32 = 0.8): f32 {
  return 1. - length(uv - vec2(0.5)) * strength
}

@fragment
export function fs(@location(0) uv: vec2): vec4 {
  let acc = 0.
  for (let i = 0; i < MAX_STEPS; i++) {
    if (i >= params.steps) {
      break
    }
    if (i % 2 === 0) {
      continue
    }
    acc += params.scale / f32(i + 1)
  }
  const twice = (x: f32): f32 => x * 2.
  return vec4(twice(acc) * vignette(uv), f32(tier(1)) / 99., 0., 1.)
}
```

## Expressions

- `+ - * / %` work componentwise on vectors of one size, and a scalar broadcasts in an operator.
  Different sizes are `TS8003`, and so is `mat4 * vec3`. `m * v` is the column-vector product and
  `v * m` the row-vector one. Integer `/` truncates; `%` truncates; `mod(x, y)` floors. `a ** b`
  is `pow`, floats only.
- Builtin functions do not broadcast (`TS8036`): `max(v, vec3(0.))`, `step(vec3(0.5), v)`,
  `pow(v, vec3(2.))`. `mix(a, b, t)` takes a scalar `t`.
- Swizzles read any mix of `xyzw` or `rgba` (`v.zyx`, `c.rgb`); `st` is refused. Write one
  component at a time. `v[i]` indexes.
- Compound assignment covers `+= -= *= /= %= &= |= ^= <<= >>=`. `++` and `--` work on scalars.
- `===` and `!==`; `==` is refused. Comparing vectors gives a `vecNb`: reduce it with `all` or
  `any`, or pick with `select(a, b, mask)`. `&&` and `||` take scalar `bool`s.
- Bits: `& | ^ ~ << >>` on `i32` and `u32`; `>>` on a `u32` is already logical, and `>>>` is
  refused. A constant shift of 32 or more, a constant zero divisor and a constant index out of
  range are compile errors.
- `Math.sin` and the rest of `Math` map to the builtins, and `Math.PI`, `PI` and `TAU` are
  constants. `Math.random()` is refused; `random(seed)` is a `fract(sin(...))` hash of an f32,
  vec2 or vec3 seed, whose result can differ between drivers.
- `console.log(...)` (also `info`, `debug`, `warn`, `error`) takes values of any fixed size
  (numbers, vectors, matrices, arrays, structs) and string literals, which are labels the host
  keeps; `"x" + y` and a template with a value in it are refused. A CPU run hands each call to
  the sink (`compile(src, { consoleSink })`). By default the WGSL and GLSL record nothing; with
  `compile(src, { console: 'gpu' })` the WGSL records every call a compute or fragment entry
  reaches in a `_console` storage buffer, and `decodeConsole(words, result.console)` reads it
  back as the CPU's lines, in the CPU's order. A call a vertex entry reaches is `TS8071` there.

## Textures

`textureSample(t, s, uv)`, `textureSample(array, s, uv, layer)`, `textureSampleLevel(t, s, uv,
0.)`, `textureSampleGrad`, `textureSampleBias`, `textureSampleCompare(depth, cmp, uv, ref)`,
`textureLoad(t, vec2i, level)`, `textureDimensions(t)` (a `vec2u`), `textureStore(dst, vec2i,
vec4)`. An integer texture is read with `textureLoad`, not sampled. A float coordinate in
`textureLoad` is `TS8041`. `texture_1d`, `texture_cube_array` and `textureGather` are WGSL-only.
On GLSL a texture and the sampler it is used with fuse into one `sampler2D`.

## Refused, and what to write instead

| Written                                              | Instead                                     |
| ---------------------------------------------------- | ------------------------------------------- |
| a string, a template literal                         | an enum for cases; text belongs on the host |
| `number`, `boolean`, `any`, `T[]`, `Array<T>`        | `f32`, `bool`, `array<T, N>`                |
| `null`, `undefined`, `f32 \| null`                   | a `bool` flag beside the value              |
| `var`                                                | `let` or `const`                            |
| `==`, `!=`, `>>>`                                    | `===`, `!==`, `>>` on a `u32`               |
| `Number`, `Array`, `Date`, `JSON` and other globals  | builtins; only `Math` and `console` exist   |
| `new Float32Array(...)`                              | `new` works only on the file's own classes  |
| `async`, `try`, generators                           | plain functions                             |
| `xs.filter(...)`, `find` and the other array methods | `for (const x of xs)`, a counted loop       |
| `typeof`, `instanceof`, `'k' in s`                   | types are static                            |
| recursion                                            | a loop                                      |

## Reserved names

A WGSL reserved word used as a name (`shared`, `as`, `filter`, `smooth`) is `TS8068`, an error. A
GLSL one used for a struct, a field or a binding (`input`, `out`, `sample`, `half`) is a warning
that drops the GLSL. Rename.
