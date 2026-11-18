# The TypeShade language, in full

What `SKILL.md` summarises, with the rest of the rules. Section numbers (§N) are those of the
compiler's normative surface, `docs/use-typeshade-surface.md` in `typeshade/typeshade`.

## The file

- The file starts with `"use typeshade"`. Without it, the whole result is one `TS8001`.
- The top level holds: functions; `class`, `interface` and `type` declarations; numeric `enum`
  and `const enum`; `namespace`; module constants (`const K: f32 = 2.`); overrides
  (`const q: override<f32> = 1.`); resources (`declare const`); module variables
  (a top-level `let`); `"enable <extension>"` directives; `import` and `export`.
- A scalar `f64` module constant folds at compile time: `const TAU2: f64 = 2 * Math.PI`. Its
  initializer may use literals, `Math` constants, earlier scalar constants, `f64(...)`, `+ - * /`
  and `abs`, `cos`, `floor`, `fract`, `max`, `min`, `mix`, `round`, `sin` and `sqrt`. A value that
  is not finite is `TS8003`. An `f32(...)` inside it rounds to `f32` there.
- Refused at the top level: an expression, an `if` or a `var` (`TS8014`), `declare function`
  (`TS8020`).
- `export` is conventional on entries and helpers, and is what another shader file imports.
- `"enable subgroups"` (also `f16`, `clip_distances`, `dual_source_blending`,
  `primitive_index`) goes after the file directive (§50); a builtin that needs an extension
  enables it by itself.
- The subgroup functions are WGSL's, with WGSL's signatures: the reductions `subgroupAdd`,
  `subgroupMul`, `subgroupMin`, `subgroupMax`, `subgroupAnd`, `subgroupOr` and `subgroupXor`;
  the scans `subgroupExclusiveAdd`, `subgroupInclusiveAdd`, `subgroupExclusiveMul` and
  `subgroupInclusiveMul`; the votes `subgroupAll`, `subgroupAny`, `subgroupBallot` and
  `subgroupElect`; and the broadcasts and shuffles `subgroupBroadcast`,
  `subgroupBroadcastFirst`, `subgroupShuffle`, `subgroupShuffleDown`, `subgroupShuffleUp` and
  `subgroupShuffleXor`. A call enables `subgroups` by itself, and `reflect().requiredFeatures`
  names it; the directive is needed only by a file that calls none. On the CPU tier and on GLSL ES
  3.00 a subgroup is one invocation.
- A kernel function needs no subgroup call: on a WebGPU device with `subgroups`, an integer
  reduction (and an `f32` `min` or `max`) runs as a second text in which each subgroup folds
  first, with the same bits as the tree (§65). An `f32` sum stays on the tree.

## Importing another shader file

A file imports what another `"use typeshade"` file exports (§68): a function, generic or not; a
class, interface or type alias; an enum; a module constant; an override; a binding; a module
variable; a namespace.

- The forms are TypeScript's: `import { a, b as c } from "./x.shade.ts"`, `import type`,
  `import * as x from "./x.shade.ts"` read one name at a time (`x.fbm(p)`), and the re-exports
  `export { a } from`, `export { a as b } from` and `export * from`.
- A compiled file that holds only the directive and one `export * from "./x.shade.ts"` is a pure
  alias: the compiler follows it, through further aliases, to the first file that is not one, and
  compiles that file as the root, with its entry points. Any other statement makes the file an
  ordinary root.
- The path is relative (`./`, `../`) to the importing file. `./x.shade.js` and `./x.shade.mjs`
  name `x.shade.ts`, and `.ts` is appended to any other path, so `./x.shade` names it too.
- A package is imported by its name, `"shade-noise"`, or a subpath, `"shade-noise/hash"`. The
  package is the first `node_modules/shade-noise/package.json` from the importing file's
  directory up, and the file read is the one its `exports` publishes under the `typeshade`
  condition, else `import`, else `default` (the package's own example is below). A package with
  no `exports` is imported by the path of its file, `"shade-noise/noise.shade.ts"`; its name
  alone names nothing. A program holds one copy of a package version, however many packages
  depend on it.
- The file compiled and the files it imports, directly or through another, are one program, and
  the program is one module. It holds the compiled file's declarations and, of each imported
  file, what they reach; an imported file's own entry points, and the bindings only they read,
  are left out. An imported file's bindings are numbered after the compiled file's own, so an
  import never moves a slot.
- Each file keeps its own scope: a private `hash` in two files is two functions. The one emitted
  first keeps the name, the compiled file's before any other, and the other is emitted as
  `stem_hash`, `stem` being its file's name, with the package's name before it for a package's
  file (`shade_noise_noise_hash`). An entry point and a binding are never renamed, so two of one
  name are `TS8023`.
- An import the compiler does not follow is `TS8072`, on the import: a path that names no file,
  a file without the directive, a name the file does not export (or declares without `export`),
  a default import or export, an import that names nothing, `import(...)` or `require`, a
  module namespace used as a value, a package no `node_modules` holds, a subpath its `exports`
  does not name, a package's name alone when it has no `exports`, and a `#` specifier.
  `compile()` reads an import, and a package's `package.json`, only through a `readDocument` you
  pass it ([host.md](host.md)), so a compile without one reports each import as `TS8072`.

```ts
// lighting.shade.ts
"use typeshade"

export class Light {
  dir: vec3
  power: f32
}

function lambert(n: vec3, l: Light): f32 {
  return max(dot(n, -l.dir), 0.) * l.power
}

export function shade(n: vec3, l: Light): vec3 {
  return vec3(0.05) + vec3(lambert(n, l))
}

// mesh.shade.ts
"use typeshade"
import { Light, shade } from "./lighting.shade.ts"

declare const sun: uniform<Light>

@fragment
export function fs(normal: location<0, vec3>): vec4 {
  return vec4(shade(normalize(normal), sun), 1.)
}
```

A package publishes its shader modules under the `typeshade` condition, beside the JavaScript it
publishes for host code. Write `typeshade` first, so plain `tsc` with `customConditions:
["typeshade"]` reads the same file:

```json
{
  "name": "shade-noise",
  "version": "1.2.0",
  "exports": {
    ".": { "typeshade": "./src/index.shade.ts", "default": "./dist/index.js" },
    "./*": { "typeshade": "./src/*.shade.ts" }
  }
}
```

`import { fbm } from "shade-noise"` reads `src/index.shade.ts`, and `import { hash } from
"shade-noise/hash"` reads `src/hash.shade.ts`.

## Types

| Kind            | Spellings                                                                                                                                                             | Notes                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| scalars         | `f32` `i32` `u32` `bool`                                                                                                                                              | `number`, `boolean`, `string`, `any` are `TS8002`                            |
| emulated double | `f64`, `vec2f64` `vec3f64` `vec4f64` (also `vec2d` ...)                                                                                                               | two f32s; a few operations only; never on stage input or output (`TS8038`)   |
| float vectors   | `vec2` `vec3` `vec4`, the same as `vec2f` ..., `vec3<f32>`                                                                                                            |                                                                              |
| other vectors   | `vec2i` ... `vec4i`, `vec2u` ... `vec4u`, `vec2b` ... `vec4b`                                                                                                         | a `vecNb` is what comparing two vectors gives                                |
| matrices        | `mat2` `mat3` `mat4`, every `matCxR` (`mat2x3`, `mat4x3` ...) and WGSL's `matCxRf` aliases (`mat4x4f`)                                                                | column-major: `m[j]` is column `j`                                           |
| arrays          | `array<T, N>`; `array<T>` runtime-sized, storage only                                                                                                                 | `T[]` is `TS8002`; an array of arrays is refused, so flatten                 |
| tuples          | `[f32, f32]` is `array<f32, 2>`                                                                                                                                       | a mixed tuple is refused: declare a struct                                   |
| structs         | `class`, `interface`, `type X = { ... }`                                                                                                                              | the same struct; an IO field's type may be `builtin<...>` or `location<...>` |
| enums           | numeric `enum`, `const enum`                                                                                                                                          | members are `i32` constants; a string member is `TS8003`                     |
| aliases         | `type Meters = f32`                                                                                                                                                   |                                                                              |
| handles         | `texture_2d<f32>`, `texture_2d_array`, `texture_cube`, `texture_3d`, `texture_depth_2d`, `sampler`, `sampler_comparison`, `texture_storage_2d<"rgba8unorm", "write">` | declared bare and `const`                                                    |

### Optional and nullable values

`T | undefined`, `T | null` and `T | null | undefined` carry a value and its absent state.
Two-state values share the physical value/presence layout. Three-state values add a null tag.
Locals, function parameters/results, class members and fixed-array elements may hold them.
Aliases, generic functions/classes, callbacks, local functions and arrows retain their logical types.
Constructor arguments, methods, static methods, getters, setters and callable fields follow the same rules.
Private, protected, readonly and inherited fields retain their access and mutation restrictions.

A present `T` lifts into an optional. Either two-state type widens to the three-state type.
Null-only and undefined-only values cannot substitute for each other without narrowing.
Reference parameters require the exact logical storage type.
Strict `=== null` and `=== undefined` tests distinguish absence; loose `!= null` excludes both.
`x ?? fallback` evaluates the fallback only when x is absent. `object?.member` gives undefined
when the object is absent and preserves null when a present object's member is null.
An un-narrowed read is `TS8003`; an optional condition and the assertion `x!` are refused.

An uninitialized `T | null` local must be assigned before reading (`TS8075`).
A class field without an initializer starts null if null is its only absent state,
and undefined if its type admits undefined. This class-field rule differs from JavaScript.
Only a field written `?` may be omitted from an object literal. `field?: T | null` admits both absent values.
Optional static data fields, module state, bindings, entry IO, kernel interfaces and host calls remain refused.

An inferred function result includes the absent states its returns use. A bare return or fall-through
supplies the absent result: null for `T | null`, undefined when the result admits undefined (0099 D3).
Without a written result type, a bare return beside a valued return adds undefined to the inferred result.

```ts
"use typeshade"
class Sample<T> {
  private stored: T | null
  constructor(value: T | null) { this.stored = value }
  get value(): T | null { return this.stored }
  set value(value: T | null) { this.stored = value }
}
function classify(value?: f32 | null): f32 {
  if (value === null) { return 1. }
  if (value === undefined) { return 2. }
  return value
}
export function nullableScore(x: f32): f32 {
  const sample: Sample<f32> | null = x < 0. ? null : new Sample<f32>(null)
  return classify(sample?.value)
}
```

### String keys and Record

A string-literal union is a key type (§75): `type Channel = "r" | "g" | "b"`.
The GPU sees a `u32` id. Members sort by UTF-16 code units, so the ids follow `"b"`, `"g"`, `"r"`.
A single string literal type is also a key type. Equal member sets are the same type.
A key supports equality and `switch` over its members. Arithmetic, ordering and conversion to a number are refused.
A literal takes its id where that key type is expected. A string outside the union is refused.
Open `string` stays refused.

`Record<K, V>` is a fixed array in key-id order. Each member has one value of `V`.
An object literal must provide every member exactly once, with no extra property.
`table[k]`, `table.r` and `table["r"]` select elements. Another key type, a number and `.length` are refused.
A numeric `K` may be an enum or an integer-literal union with distinct values exactly 0 through N-1.
It indexes by member value. Gaps, negatives and nonintegers are refused with a sentence naming the values.
`Record<u32, V>` is refused because its domain is open.

```ts
"use typeshade"
type Channel = "r" | "g" | "b"
export function gain(c: Channel, by: Record<Channel, f32>): f32 {
  switch (c) {
    case "r": return by.r
    default: return by[c]
  }
}
```

The host passes and receives the string for a key, and an object for a `Record` parameter or result.
A string outside the union, a missing property and an extra property produce a `TypeError`.
In entry bindings and runtime-sized kernel arrays, keys remain numeric ids and records remain arrays in id order.
This is proposal 0081's open deviation D1.

### Literals

- A float is written with a dot: `1.`, `0.5`.
- An integer-written literal takes its type from where it stands: an annotation, a parameter, a
  return type, a struct field, an element of `vec3u(...)` or of an annotated list, a typed operand
  beside it. `let n: u32 = 7` and `gid.x < 100` are fine.
- An unannotated `let`, a module variable or a written field initialized by an integer-written
  literal takes its type from every place the value reaches (§13): a typed operand, a builtin
  argument beside a typed one, a constructor's element, a conditional's other arm, a field, a
  declared parameter or result, a compound assignment. An index makes it an integer, `i32` unless
  another use says `u32`, so `let i = 0; xs[i]` works. A `const` of a written number has no
  fixed type until a read gives it one, as WGSL's abstract `const`. A function with no result
  type that returns a written number takes the type its callers use.
- Uses that demand two types are `TS8003`: annotate. A `/` whose integer operands all got their
  type by inference is `TS8003` too: annotate the value for integer division (`let k: u32 = 7`)
  or convert it (`f32(k) / 2`).
- An integer array is written as an annotated list, `const w: array<i32, 3> = [1, 2, 1]`.

### Conversions

- Scalars: `f32(x)`, `i32(x)`, `u32(x)`, `bool(x)`, `f64(x)`. A float to an integer truncates
  toward zero and saturates at the integer's range, the same on every target. `u32(i)` and
  `i32(u)` reinterpret the bits.
- Vectors: through the constructor, `vec3(v3u)`, `vec3u(v)`, `vec2i(p)`, `vec2(gid.xy)`. The sizes
  must match. `f32(v)` on a vector is `TS8003`.
- Constructors: `vec3(0.5)` splats; `vec4(v3, 1.)` and `vec4(v2, v2)` compose; `vec3()` is zero, and
  `array<u32, 32>()` is 32 zeros; `vec3<u32>(1, 2, 3)` names the element type; `array(1., 2., 3.)` is an `array<f32, 3>`;
  `mat3(m4)` truncates; `mat3(c0, c1, c2)` builds from columns.
- `x as T` is a claim to the type checker, not a conversion, and emits nothing.
- `bitcast<u32>(x)` reinterprets the bits of an `f32`, and `bitcast<f32>(u)` the reverse. A
  vector reads each component the same way: `bitcast<vec4u>(v)` on a `vec4`, `bitcast<vec4>(w)` on
  a `vec4u`, and the same for `vec2` and `vec3`. A vector of another width is `TS8003`.
- A NaN or subnormal bit pattern has no portable `bitcast<u32>`: a GPU may flush it and the CPU
  oracle gives a NaN back as `0x7fc00000`. A small integer is a subnormal `f32` pattern, so keep
  integer words in a `storage<array<u32>>` or `storage<array<vec4u>>` binding, not in the bits of
  an `f32`.

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
- A missing required field or an extra field is `TS8010`. A field written `?` may be omitted. Two declarations of one name in one scope are
  `TS8023`, interfaces included (TypeScript would merge them; TypeShade does not).
- An object (a struct, a class instance, an array) has the identity a JavaScript object has:
  passing it to a function passes the caller's object, and a write to its field or element there
  changes it. A number, a `bool`, a vector and a matrix are values.
- Classes have methods, a constructor, static members, getters and setters, `#private` members,
  parameter properties and `readonly`, and are built with `new` (§26). A method that assigns to
  `this` needs a `let` receiver (`TS8035` on a `const`). A method that changes its object, called
  on an element (`voices[v].tick(x)`), is a write to that element, for the kernel proof (§65) as
  for any other write. A class is one thing on every tier and on the host: the host imports an
  exported class as a class, and `new` runs its constructor on the CPU tier. Generic functions and classes are
  compiled once per type used (§30, §32). `namespace N { export function f() }` becomes `N_f`.
- A class may have no instance fields (§26): `class Empty {}`, a class of methods or getters
  only, and a class of static members are built with `new` like any other. The host and a CPU
  run see its value as `{}`; the GPU code carries a hidden `u32` in its place.
- A derived class value goes where its base is declared (an argument, a field, a return, an
  annotated `let`) when the compiler proves the base view read-only (§26): no override changes
  a call made through the base, and nothing writes the value or its inherited fields through a
  method or an alias. The value is then copied as the base. What the proof cannot show is
  `TS8003`, whose remedy is to keep the derived type: there is no runtime dispatch through a
  base type.
- IO fields carry their meaning in their type: `builtin<"position">`, `location<1, u32, {
interpolate: "flat" }>`, `builtin<"position", { invariant: true }>`, `location<0, vec4, {
blend_src: 1 }>`. `@align`, `@size` and `@offset` are refused: the compiler lays out buffers
  itself.

```ts
"use typeshade"

class Material {
  albedo: vec3
  tint(k: f32): vec3 {
    return this.albedo * k
  }
}

class LeafMaterial extends Material {
  vein: f32
}

class Leaf {
  material: Material
  constructor(material: Material) {
    this.material = material
  }
}

class Shading {
  half(c: vec3): vec3 {
    return c * 0.5
  }
}

export function leafColor(): vec3 {
  const leaf = new Leaf(new LeafMaterial())
  return new Shading().half(leaf.material.tint(0.5))
}
```

An override that a call through the base would reach is refused:

<!-- expect: TS8003 -->

```ts
"use typeshade"

class Material {
  albedo: vec3
  tint(k: f32): vec3 {
    return this.albedo * k
  }
}

class Glow extends Material {
  tint(k: f32): vec3 {
    return vec3(k)
  }
}

class Leaf {
  material: Material
  constructor(material: Material) {
    this.material = material
  }
}

export function leafColor(): vec3 {
  const leaf = new Leaf(new Glow())
  return leaf.material.tint(0.5)
}
```

## Resources

- `declare const u: uniform<T>`: a uniform buffer. `T` is a struct, or a bare scalar, vector or
  `f32` matrix of three or four rows (`uniform<f32>`), which GLSL holds in a block of its own.
- `declare const s: storage<T>` is read-only storage; `declare const s: storage<T, "read_write">`
  is read-write. The access mode is the second type argument, `"read"` (the default) or
  `"read_write"`. Every resource is `declare const`: `declare let` on one is `TS8099`, which names
  the line to write. Writing a read-only resource is `TS8005` in the compiler and `TS2542` or
  `TS2540` in the editor.
- `declare const tex: texture_2d<f32>` and `declare const smp: sampler`: handles, bare and
  `const`.
- `const q: override<f32> = 0.5`: a pipeline override, scalar only, set by the host at pipeline
  creation. It takes no binding slot and stays symbolic through optimization. An integer
  override can be a runtime loop bound. An `override<u32>` can also set a `@compute` dimension and the outer count of a
  workgroup array.
- `let seed: u32 = 7` at the top level: a per-invocation module variable.
- `let tile: workgroup<array<f32, WG_SIZE>>`: workgroup memory, with no initializer, compute
  only. Its fixed outer count may be an integer constant or a `u32` override.
- `declare const bins: storage<array<atomic<u32>>, "read_write">`: atomics (`atomic<u32>` or `atomic<i32>`), in
  read-write storage only, used through `atomicAdd(bins[i], 1)` and the other atomic builtins.
- **Slots.** Every `declare` resource is `@group(0)`, numbered `@binding(0)`, `@binding(1)` ...
  in declaration order, textures and samplers included, the compiled file's own before those of
  the files it imports; overrides and module variables take no slot. There is no syntax to
  choose a slot. Read them from the reflection. The compiler's own bindings come after yours:
  `_fp64` when emulated doubles need it, and `_console` under
  `compile(src, { console: 'gpu' })`.
- **Runtime-sized arrays.** `array<T>` only as a storage binding or the last field of a storage
  struct. Its `.length` is a runtime `u32`; on anything not in storage
  it is `TS8032`.
- **Layout.** A `bool` field in a buffer struct is `TS8051` (use `u32`). `mat2`, `mat3x2` and
  `mat4x2` in a uniform drop the GLSL, since std140 and WGSL lay a two-row matrix out
  differently; use `mat2x4` or two `vec2`s. `array<f32, N>` in a uniform struct is padded to 16
  bytes per element for you. Host code packs buffers at the offsets the reflection reports.
- **What leaves GLSL out.** A read-write storage buffer, an atomic, workgroup memory, a storage
  texture or a compute entry makes the module WGSL-only. Read-only storage read in a render
  stage becomes a data texture in GLSL.

## Entry points

- The stage attributes `@vertex`, `@fragment` and `@compute` go on top-level exported
  functions: `@vertex export function vs(...)`. A function without one is a helper. Calling an
  entry is refused: move the body into a helper both call. A kernel function may state its
  workgroup size with `@workgroup_size([128])`.
- `@compute([x, y, z])` takes one to three dimensions, with omitted dimensions equal to 1.
  `[8, 8]` is a two-dimensional workgroup. A bare `@compute` is a workgroup of 64.
  A dimension may be a numeric literal, a named integer
  constant or an `override<u32>`. The same override may size the outer count of a workgroup array:

```ts
"use typeshade";

const WG_SIZE: override<u32> = 64;
let tile: workgroup<array<f32, WG_SIZE>>;

@compute([WG_SIZE])
export function copy(lid: builtin<"local_invocation_id">): void {
  tile[lid.x] = 0.;
}
```

The workgroup array must be the outer array in workgroup memory. The runtime checks specialized
dimensions against device limits when it creates a pipeline. An imported compute entry accepts
`entry(bindings, groups, { constants: { WG_SIZE: selected } })`, directly or in `device.fuse()`.
The selected size determines shared-array lengths and CPU builtins too; the caller calculates
`groups` for it. WebGL2 supports only the default shape and shared-array lengths.

- **A builtin is a typed parameter or field**, `vi: builtin<"vertex_index">`, and WGSL gives its
  type. Vertex: `vertex_index` and `instance_index` (`u32`). Vertex output and fragment input:
  `position` (`vec4`). Fragment: `front_facing` (`bool`), `sample_index` and `sample_mask`
  (`u32`, both WGSL-only), `frag_depth` (`f32`, output). Compute: `global_invocation_id`,
  `local_invocation_id`, `workgroup_id`, `num_workgroups` (all `vec3u`),
  `local_invocation_index` (`u32`), and with subgroups `subgroup_invocation_id`,
  `subgroup_size`, `subgroup_id` and `num_subgroups` (`u32`). Only `clip_distances` writes its
  type: `builtin<"clip_distances", array<f32, 4>>`. An unknown id is `TS8024`, the wrong stage
  `TS8025`.
- **Stage IO.** Every other input or output is user-defined, and the compiler gives it its
  location: a vertex entry's parameters and fields, a vertex result's fields and a fragment
  result's fields each in declaration order. A fragment input takes the location of the vertex
  result field of the same name (`TS8010` when no vertex result has it). `location<n, T>` fixes a
  number or states an option, as in a fragment-only file. A compute entry has no user-defined
  input (`TS8029`). Integer varyings are `flat` automatically; a `bool` varying is refused. Share
  one class between the stages: a value between stages is linked by its name.
- **Returns.** A vertex entry returns `vec4` (the position) or a struct with a
  `builtin<"position">` field. A fragment entry returns `f32` ... `vec4` (location 0), a struct of
  render targets (optionally with `builtin<"frag_depth">`), or `void`. A compute entry returns
  nothing. The return type is inferred from the body; write it only for another built-in value
  (`builtin<"frag_depth", f32>`) or an option on the output.
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

- Annotate every parameter. A function's return type, an entry's included, is inferred from its
  body. A bare `return` where a value is required is `TS8021`.
- An object parameter (a struct, a class instance, an array) is the caller's object, and a write
  into it changes the caller's. A number, `bool`, vector or matrix parameter is a value: a whole
  write (`x = 0.`) changes a local copy, and a write into one (`v.x = 1.`) is `TS8018`.
  Default values work (`b: f32 = 0.8`) as long as they do not read another parameter; optional
  (`b?: f32`) parameters hold `f32 | undefined`; omission supplies undefined. Rest parameters are `TS8020`.
  An optional parameter on an entry or kernel function, a required parameter after an optional one,
  and `b?: f32 = 1.` are also `TS8020`.
- `const` is immutable (`TS8005`), `let` is mutable. `let x: f32` without an initializer needs
  its annotation. A read of it before it is assigned on every path is `TS8075`, by TypeScript's
  rule for TS2454 (the editor shows `TS8075` in its place), and every target starts it at zero:
  WGSL and the CPU, and GLSL, which writes the zero as its initializer (`float x = 0.0;`).
- Block scope and shadowing work as in TypeScript. A parameter or a local may shadow a module
  constant, a binding, an override or a module variable (`const u = fract(p)` beside a
  `declare const u: uniform<Frame>`); the module's `u` keeps its name in the emitted code. Two
  declarations in one scope, a local that repeats a parameter included, are `TS8023`.
- Destructuring a vector or a struct works (`const { x, y } = v`). A fixed array supports
  `const [a, , c] = xs`, with omitted positions and nested patterns. Rest elements and defaults remain refused. The source is evaluated once.
  A runtime-sized array pattern is refused (change 0086).
- A local function is a nested `function` or an arrow constant, and it may read and write the
  locals and parameters around it. A parameter
  may be a function (`h: (x: f32) => f32`), and an arrow may be written as the argument.
- Recursion, direct or mutual, is `TS8031`.
- A call alone on a line is fine; a value alone on a line (`vec3(1.)`) is refused.
- `if` needs a `bool` condition (`if (x)` on an `f32` is `TS8003`). The ternary works on any
  type. `select(f, t, cond)` puts the condition last, as WGSL does.
- `for` means what it means in TypeScript: the initializer once, the condition before each trip
  (none is `true`), the update after each trip and at each `continue`. A `for` that steps one
  integer `let` by a constant (`++`, `--`, `+=`, `-=`, `*=`, `/=`) toward a bound is counted; the
  start and the bound may be runtime values (a parameter, a uniform field, `xs.length`), with no
  limit on the trips. An unannotated counter starting at a non-negative literal takes the type of
  a `u32` bound. Any other `for` (a float counter, two counters, a bound the body writes, no
  condition) runs as a `while` does. Refused: a loop the compiler proves never ends, with no
  condition and no `break` or `return`, or a constant step that never moves the counter toward
  the bound (`TS8007`); a constant header that leaves its counter's type (`TS8006`). In a kernel
  function, a `for` that is not counted runs on the CPU (`TS8070`).
- `for (const x of xs)` iterates an `array<T, N>` or a runtime-sized storage array.
- Five array methods run as TypeScript runs them, each lowered to a counted loop:
  `xs.forEach(f)`, `xs.some(p)`, `xs.every(p)`, `xs.reduce(f, init)` (or `xs.reduce(f)` on a
  non-empty fixed-size array), and `xs.map(f)`, which returns an `array<R, N>` and so takes a
  fixed-size array only. The function is a name, an arrow or a function expression written in
  the call, taking `(value, index, array)` with `index` an `i32`. `filter` is refused; use a loop or a kernel `push`. Kernel arrays also support the methods below.
- `while` takes any `bool` condition; `while (true)` needs a `break` or a `return` in its body
  (`TS8007`). `do...while`, labels and `for...in` are refused.
- `switch` is on an integer or a key type, with matching constant labels (`TS8017` otherwise). A case body that
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
export function fs(uv: location<0, vec2>): vec4 {
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

## Objects are references, numbers are values

An object has the identity a JavaScript object has. A struct, a class instance and an array (with
a size or with none) are objects; a number, a `bool`, a vector and a matrix are values, as a
JavaScript primitive is.

- A function that writes a field or an element of an object parameter changes the caller's
  object: `advance(r, t)`, `advance(rays[i], t)` on an element of a storage binding, a
  fixed-size array passed whole. The compiler passes the place.
- A function that gives back a number or a vector returns it. For more than one, it returns a
  tuple and the caller destructures it: `const [lo, hi] = order(a, b)`.
- `@inout` and `@out` are removed. A parameter that carries one is `TS8073`, and the message says
  what to write instead; `tshc migrate` deletes them.
- Where the compiler does not yet implement JavaScript's sharing for a form, it refuses the
  program with a diagnostic that says "not supported yet".

```ts
"use typeshade"

class Ray {
  origin: vec3
  dir: vec3
}

function advance(r: Ray, t: f32): void {
  r.origin = r.origin + r.dir * t
}

function order(lo: f32, hi: f32): [f32, f32] {
  return lo > hi ? [hi, lo] : [lo, hi]
}

export function demo(): f32 {
  const [lo, hi] = order(2., 1.)
  let r = new Ray()
  r.dir = vec3(1., 0., 0.)
  advance(r, 3.)
  return lo + hi + r.origin.x
}
```

<!-- expect: TS8073 -->

```ts
"use typeshade"

function swap(@inout a: f32, @inout b: f32): void {
  const t = a
  a = b
  b = t
}

export function demo(): f32 {
  let x: f32 = 1.
  let y: f32 = 2.
  swap(x, y)
  return y
}
```

## Expressions

- `+ - * / %` work componentwise on vectors of one size, and a scalar broadcasts in an operator.
  Different sizes are `TS8003`, and so is `mat4 * vec3`. `m * v` is the column-vector product and
  `v * m` the row-vector one. Integer `/` truncates; `%` truncates; `mod(x, y)` floors. `a ** b`
  is the power, floats only, with both sides of one type (`v ** vec3(2.)`).
- Builtin functions do not broadcast (`TS8036`): `clamp(v, vec3(0.), vec3(1.))`,
  `step(vec3(0.5), v)`. `max`, `min` and `mix(a, b, t)` take a scalar beside a vector.
- One spelling for one meaning: where ECMAScript has a spelling, the WGSL or extra name is
  removed. Write `a ** b` (not `pow`), `xs.length` (not `arrayLength`), `Math.PI` and `Math.E`
  (not `PI`, `E`, `LN2` ...), `Math.log10`, `Math.log1p`, `Math.expm1`, `Math.cbrt` and
  `Math.hypot`, `xs.some(p)`, `xs.every(p)` and `!xs.some(p)` (not `any(xs, p)`, `all(xs, p)`,
  `none(xs, p)`), and `xs.reduce((a, b) => a + b)` (not `sum(xs)`). `TAU`, `select`, `atan2`,
  `any(v)` and `all(v)` on bools, `mod`, `fill`, `zip` and `random` stay.
- Swizzles read any mix of `xyzw` or `rgba` (`v.zyx`, `c.rgb`); `st` is refused. A swizzle of a
  local is an assignment target, with `=` and every compound operator: `d.xy *= d.yx` reads
  every old component before it writes one. A swizzle that names a component twice (`d.xx = r`)
  is `TS8018`. `v[i]` indexes.
- Compound assignment covers `+= -= *= /= %= &= |= ^= <<= >>=`. `++` and `--` work on scalars.
- `===` and `!==`; `==` is refused. Comparing vectors gives a `vecNb`: reduce it with `all` or
  `any`, or pick with `select(a, b, mask)`. `&&` and `||` take scalar `bool`s.
- Bits: `& | ^ ~ << >>` on `i32` and `u32`; `>>` on a `u32` is already logical, and `>>>` is
  refused. A constant shift of 32 or more, a constant zero divisor and a constant index out of
  range are compile errors.
- `Math.sin` and the rest of `Math` map to the builtins, and `Math.PI` and `TAU` are constants. `Math.random()` is refused; `random(seed)` is a `fract(sin(...))` hash of an f32,
  vec2 or vec3 seed, whose result can differ between drivers.
- `console.log(...)` (also `info`, `debug`, `warn`, `error`) takes values of any fixed size
  (numbers, vectors, matrices, arrays, structs) and string literals, which are labels the host
  keeps; `"x" + y` and a template with a value in it are refused. A CPU run hands each call to
  the sink (`compile(src, { consoleSink })`). By default the WGSL and GLSL record nothing; with
  `compile(src, { console: 'gpu' })` the WGSL records every call a compute or fragment entry
  reaches in a `_console` storage buffer, and `decodeConsole(words, result.console)` reads it
  back as the CPU's lines, in the CPU's order. A call a vertex entry reaches is `TS8071` there.
- `console.table(x)` takes one value (an array, a struct, a vector, a matrix or a scalar) and
  the host prints it with its own `console.table`: an array of structs as a row per element, a
  matrix by column (`m[j]` is column `j`). A second argument, the columns to show, and a text
  argument are `TS8099`: pick the fields in the shader, into a smaller struct. Every other
  `console` method (`count`, `assert`, `time`, `group`, …) is `TS8099` too.

## Textures

`textureSample(t, s, uv)`, `textureSample(array, s, uv, layer)`, `textureSampleLevel(t, s, uv,
0.)`, `textureSampleGrad`, `textureSampleBias`, `textureSampleCompare(depth, cmp, uv, ref)`,
`textureLoad(t, vec2i, level)`, `textureDimensions(t)` (a `vec2u`), `textureStore(dst, vec2i,
vec4)`. An integer texture is read with `textureLoad`, not sampled. A float coordinate in
`textureLoad` is `TS8041`. `texture_1d`, `texture_cube_array` and `textureGather` are WGSL-only.
On GLSL a texture and the sampler it is used with fuse into one `sampler2D`.

## Refused, and what to write instead

| Written                                             | Instead                                                        |
| --------------------------------------------------- | -------------------------------------------------------------- |
| an open string, a template literal                  | a string-literal key union for cases; text belongs on the host |
| `number`, `boolean`, `any`, `T[]`, `Array<T>`       | `f32`, `bool`, `array<T, N>`                                   |
| `var`                                               | `let` or `const`                                               |
| `>>>`                                               | `>>` on a `u32`                                                |
| `Number`, `Array`, `Date`, `JSON` and other globals | builtins; only `Math` and `console` exist                      |
| `new Float32Array(...)`                             | `new` builds only the program's own classes                    |
| `async`, `try`, generators                          | plain functions                                                |
| `xs.filter(...)` and unsupported array methods      | `for (const x of xs)`, a counted loop                          |
| `typeof`, `instanceof`, `'k' in s`                  | types are static                                               |
| recursion                                           | a loop                                                         |

## Reserved names

A WGSL reserved word used as a name (`shared`, `as`, `filter`, `smooth`) is `TS8068`, an error. A
GLSL one used for a struct, a field or a binding (`input`, `out`, `sample`, `half`) is a warning
that drops the GLSL. Rename.

## Kernel array methods and collections

A kernel function accepts arrays with no size (§65). Its `forEach`, `some`, `every` and `reduce`
run on the GPU when their loops satisfy the independence rules.
It also supports `findIndex`, `findLastIndex`, `indexOf`, `lastIndexOf`, `includes`, `fill` and `copyWithin`.
Searches return the first or last matching index, or -1. `some`, `every` and `includes` visit every element.
A callback cannot write a captured value. `map` needs a fixed-size result; `filter` remains refused.
`reduce` uses the same tree order on every tier, which can differ from TypeScript's left-to-right sum.

A loop can append with `out.push(v)` as a statement (§65).
The output starts empty, and appends retain sequential iteration order on every tier.
The host array supplies capacity. The call writes the prefix that fits and preserves its tail.
`out.length` after the loop is the appended count, which can exceed capacity.
Return that count so the host can retry with a larger array.
WebGPU counts, scans offsets and writes in three dispatches. WebGL2 cannot run a loop that pushes.
A pushing loop forms a group of its own in `fuse`.

A kernel parameter may be `Set<K>` or `Map<K, V>` (§74).
`K` is `u32`, `i32`, `f32`, or a string-literal key type. `Map<string, V>` and `Set<string>` are refused.
A loop writes with `add(k)` or `set(k, v)` as a statement.
A later loop reads `has`, `size`, or `get(k)!` guarded by `has(k)`.
The host passes JavaScript's `Set` or `Map`. Keys retain their first insertion order and each Map value is the last set.
String keys convert to ids before the loops and back to strings afterward. An unknown host string is a `TypeError`.
WebGPU and CPU support these kernels; WebGL2 cannot run their collection loops.

Kernel functions preserve their results when the final workgroup has idle lanes (0096).
Those lanes run the last logical iteration but do not write its result.
