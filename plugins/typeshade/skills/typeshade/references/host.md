# TypeShade on the host side

A host uses a shader module one of three ways:

- **It imports the module** through the `typeshade/vite` plugin and calls its exports. A helper
  runs on the CPU. A kernel function's loops run on the GPU when the compiler proves them
  independent, and a chain of kernel calls can run as one dispatch inside a `fuse` scope. A
  `@compute` entry dispatches on WebGPU, and a full-screen `@fragment` entry draws into a canvas.
  The calls request a WebGPU device and make the pipelines themselves, or use the program
  runtime's device once `configure({ runtime: rt })` names one.
- **It loads the compiled program into the program runtime**, `typeshade/runtime`, and draws and
  dispatches it with its own frames: the runtime handles the device, the pipelines, the bindings
  by name and the console, and the application ships no compiler.
- **It compiles the file** (in a build step or at start-up) and hands the emitted WGSL or GLSL to
  its own WebGPU or WebGL2 code. Nothing of TypeShade runs then.

## Importing a .shade.ts

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { typeshade } from 'typeshade/vite'

export default defineConfig({ plugins: [typeshade()] })
```

```jsonc
// tsconfig.json of the host project: two lines
"moduleSuffixes": [".typeshade", ""],
"exclude": ["src/**/*.shade.ts"]
```

Add `"prepare": "tshc sync"` to `package.json` and `*.shade.typeshade.ts` to `.gitignore`.
`tshc` is the command the `typeshade` package installs. The plugin writes a host view,
`name.shade.typeshade.ts`, beside each module, and `moduleSuffixes` makes `tsc` and the editor
read it in place of the source. `tshc sync` writes every view before `tsc` runs on a clean
checkout.

```ts
import { resident } from 'typeshade'
import { height, render } from './terrain.shade.ts'
import { scale, blockSum } from './kernels.shade.ts'
import { fs } from './plasma.shade.ts'

const k = [1, 0.5, 2, 0.25] as const
const h = height([0.5, 0.5], k) // a number
const img = new Float32Array(512 * 512)
await render(k, 512, img) // each loop the compiler proves ran on the GPU; img is filled in place
await scale({ k: 2.5, xs, ys }, 4) // four workgroups; ys, a Float32Array, is filled in place

const onGpu = resident(new Float32Array(256))
const sums = resident(new Float32Array(4))
scale({ k: 2.5, xs, ys: onGpu }, 4) // queued: every binding it writes is a Resident
blockSum({ xs: onGpu, sums, scratch: resident(new Float32Array(256)) }, 4) // reads scale's output
const out = await sums.read() // the one wait

fs(canvas, { frame: { time: 0, scale: 0.02 } }) // draws one frame; nothing is read back
```

- **A helper** a host can call is exported, not generic, takes no function, and reaches no
  binding, workgroup variable or GPU-only builtin. It runs on the CPU at f32, synchronously.
- **A kernel function** is an exported function that takes an array with no size, `array<f32>`
  or an array of vectors or structs. When the compiler proves, for each `for` at the top of its
  body, that no iteration touches what another does, each loop runs on the GPU, one invocation
  per iteration. When it cannot prove one, the whole function runs on the CPU, with a `TS8070`
  warning on that loop that names the line and the fix. The call is asynchronous,
  `await render(k, 512, img)`, and returns `Promise<void>`, or `Promise<R>` for a result. Each
  array is a `Float32Array`, `Int32Array` or `Uint32Array` (the scalar's typed array for
  vectors, an array of objects for structs), and each one the function writes is read back into
  yours in place. It runs on the first tier that can run it: WebGPU, then WebGL2 (only when every
  loop writes one array of numbers at `i`), then the CPU. `configure({ prefer })` orders them.
- **A `@compute` entry** is `entry(bindings, workgroups, options?)`. `bindings` has one property for each
  binding the entry reaches, typed exactly, so a missing or misspelled binding is a type error.
  `workgroups` is `n`, `[x, y, z]`, or `{ indirect, offset }`. The indirect form reads three
  workgroup counts at the element offset of a `Resident<Uint32Array>` when the call runs.
  The count buffer must share the device owner and must contain all three words. The promise resolves once every
  storage binding it writes has been read back into the caller's value. `options.constants`
  selects declared overrides by name; omitted constants keep their defaults. It runs on WebGPU,
  supported WebGL2 compute, then the CPU tier. The CPU tier refuses barriers and texture reads.
  `configure({ prefer })` orders the tiers. The specialization example below covers their limits.
- **A `Resident`**, `resident(array)` from `typeshade`, stands for a storage array with no size, or
  a kernel function's array, and stays on the device: nothing is read back until `await r.read()`.
  When every binding or array a call writes is a `Resident`, the call only queues and returns
  nothing. Entry calls and kernel calls run in the order they were made, and so does a draw that
  reads a `Resident`, so one call's output can be the next one's input.
- **A `fuse` scope** runs a chain of kernel calls over `Resident` arrays as one plan. On WebGPU the
  calls reach the queue in one submission, and calls that follow each other become one dispatch
  when the compiler's facts allow it. `fuse` comes from `typeshade/fuse`, and the plugin needs
  `typeshade({ fuse: true })`. The section "A chain of kernel calls in one dispatch" has the
  example, the facts, the report and the scratch arrays.
- **A full-screen `@fragment` entry** is `entry(canvas, bindings)`, into an `HTMLCanvasElement`
  or an `OffscreenCanvas`. It draws one frame that fills the canvas, on WebGPU, then WebGL2, then
  the CPU, and the first draw into a canvas decides its tier. The promise resolves when the frame
  is submitted, and nothing is read back. An entry that reads a storage buffer has no WebGL2 tier,
  and one that reads a texture has no CPU tier.
- Every other export is `never` in the view, with the reason, so calling one is a type error.
- **Host values:**
  - a number for a scalar, a boolean for a `bool`
  - a union member string for a key-type parameter or result
  - an object with every key for a `Record` parameter or result
  - a tuple for a `vecN`
  - a flat column-major array for a matrix
  - an object for a struct
  - a typed array for a runtime-sized storage array, or an array of objects for one of structs
  - an image source (`ImageBitmap`, `ImageData`, an image, a canvas or a video) for a
    `texture_2d<f32>`, and `{ filter, address }` or nothing for a `sampler`
- The module must be named `*.shade.ts`. A compile error fails the build with its `TS80xx`
  diagnostics.
- A module that imports another shader module ([language.md](language.md)) is compiled with it:
  the plugin reads each file the module imports from disk, a package's found in `node_modules`
  from the module's directory up, and `vite dev` rebuilds the module when one of them changes.
  The view holds the module's own exports and what it re-exports. A host file that imports a
  package's `.shade.ts` itself is not supported yet.
- A `console.*` call prints in the browser console after where it ran: the tier, the file and
  line, and the invocation, as in `GPU  particles.shade.ts:14  [3, 0, 0]  x 4.5`. The plugin's
  `console` option says when the GPU records the calls: `'dev'`, the default, in `vite dev` only,
  `'always'` in a production build too, and `'never'` in neither. `typeshade({ ir: true })` also
  puts each module's IR in its default export, for the load-time emitter below.

## Device owners

`createDevice(options)` from `typeshade/runtime` opens an owner on the first available tier in `prefer`.
It can use the host's `device`, or a program runtime through `{ runtime }`.
`device.array(values)` uploads an array; `device.array(length, 'f32')` obtains a pooled array.
A `Resident` belongs to one owner for its life. Calls refuse arrays from another owner.
`device.release(r)` returns an array to the pool. `device.dispose()` drains calls and frees owned resources.
`poolBytes` bounds the pool. Import `typeshade/fuse` to enable `device.fuse(body)`.

`fp64Flavor` is `'float'` (the default) or `'integer'` on `createDevice(options)` and `configure(options)`.
`recommendFp64Flavor({ adapterInfo: adapter.info, userAgent })` recommends integer emulation on
Apple GPUs and float emulation elsewhere. Pass its result as `fp64Flavor`; `device.fp64Flavor`
reports the owner's choice, which entry specializations retain.

`timeBudgetMs` bounds one chunk, defaults to 250, and must be finite from 1 through 60000.
`device.chunkSize(key, max, min = 1)` sizes the next chunk from previous timings.
`device.fuse(body, { chunk: { key, units, timed } })` fences and times it; `timed: false` skips rate learning.
The report carries `chunk`, and `device.chunkRates` exposes measured rates.

## Specializing an imported compute entry

Declare overrides in `copy.shade.ts`. This entry has no barrier, so its selected shape also runs
on the CPU tier:

```ts
"use typeshade";

const WIDTH: override<u32> = 64;
const GAIN: override<f32> = 1.;
declare const xs: storage<array<f32>>;
declare const ys: storage<array<f32>, "read_write">;

@compute([WIDTH])
export function copy(@builtin("global_invocation_id") gid: vec3u): void {
  if (gid.x < xs.length) {
    ys[gid.x] = xs[gid.x] * GAIN;
  }
}
```

The third argument works in direct calls and in device plans. Two-argument calls keep the
authored defaults. Ordinary host TypeScript chooses the width and calculates the workgroup count:

```ts
import { createDevice } from 'typeshade/runtime'
import 'typeshade/fuse'
import { copy } from './copy.shade.ts'

const xs = Float32Array.from({ length: 259 }, (_, i) => i)
const ys = new Float32Array(xs.length)
await copy({ xs, ys }, Math.ceil(xs.length / 64), { constants: { GAIN: 2 } })

const device = await createDevice()
try {
  const width = device.tier === 'webgl2' ? 64 : 32
  const input = device.array(xs)
  const output = device.array(xs.length, 'f32')
  const report = await device.fuse(() => {
    copy({ xs: input, ys: output }, Math.ceil(xs.length / width), {
      constants: { WIDTH: width, GAIN: 2 },
    })
  })
  // WebGPU: one dispatch and one submission; workgroupShapes is [[32, 1, 1]].
  const values = await output.read()
} finally {
  await device.dispose()
}
```

An entry call stays a group of its own and shares the plan's submission. Selecting constants
adds no fence or readback. On WebGPU the group's `workgroupShapes` contains the resolved shape;
indirect counts remain supported. The runtime snapshots constants when the call is made.
It validates declared names, scalar types and ranges, positive extents, and the active device's
workgroup dimensions, invocation count and workgroup-storage limits before uploads.

Pipelines are cached per device, entry, normalized constants and fp64 flavor. Key order and
equivalent boolean values reuse the same specialization. Choose a small set of measured widths
to bound the number of pipelines; the runtime does not tune the width or change dispatch counts.
The CPU tier uses generated closures, selected builtins and resized workgroup arrays without
loading the compiler or generating code at run time. Specialized CPU allocations use portable
WebGPU minimum limits. A barrier remains unsupported on that tier.

WebGL2 pins ordinary constants such as `GAIN`, but requires the authored default workgroup shape
and workgroup-array lengths. A changed shape or length is refused before submission. The
compiler's `examples/hosts/host-compute/` contains executable default, direct and planned calls,
checked against an independent reference on all three tiers.

## A chain of kernel calls in one dispatch

A host that calls several kernel functions one after another pays a submission for each call and a
dispatch for each loop. `fuse` from `typeshade/fuse` records the calls its body makes and runs them
together when the body returns. The host imports `fuse` on purpose: the package root and
`typeshade/runtime` do not export it. The same subpath exports the types `FuseReport` and
`FuseScope`. `FuseReport` and `mergeReports` also come from `typeshade/runtime`, without the planner.

Write each operation as a kernel function with one loop. `total` reduces:

```ts
"use typeshade"

export function add(out: array<f32>, a: array<f32>, b: array<f32>): void {
  for (let i: u32 = 0; i < out.length; i++) {
    out[i] = a[i] + b[i]
  }
}

export function mul(out: array<f32>, a: array<f32>, b: array<f32>): void {
  for (let i: u32 = 0; i < out.length; i++) {
    out[i] = a[i] * b[i]
  }
}

export function relu(out: array<f32>, x: array<f32>): void {
  for (let i: u32 = 0; i < out.length; i++) {
    out[i] = max(x[i], 0.)
  }
}

export function total(xs: array<f32>): f32 {
  let s = 0.
  for (let i: u32 = 0; i < xs.length; i++) {
    s += xs[i]
  }
  return s
}
```

Call them inside `fuse`:

```ts
import { resident } from 'typeshade/runtime'
import { fuse } from 'typeshade/fuse'
import { add, mul, relu } from './ops.shade.ts'

const a = resident(xs) // xs, ys and zs are Float32Array of n elements
const b = resident(ys)
const c = resident(zs)
const out = resident(new Float32Array(n))
const report = await fuse((scope) => {
  const t = scope.scratch(n)
  const u = scope.scratch(n)
  add(t, a, b)
  mul(u, t, c)
  relu(out, u)
})
report.dispatches // 1: the three loops are one dispatch
report.submissions // 1
const y = await out.read() // relu((a + b) * c)
```

**The option.** The plan is made from facts that the compiler writes into the module. It writes them
only under `typeshade({ fuse: true })`, in `vite dev` and in `vite build`:

```ts
// vite.config.ts
export default defineConfig({ plugins: [typeshade({ fuse: true })] })
```

The record of a kernel function adds, minified and gzipped, about 0.7 kB to a module of one function
that maps and about 1.3 kB to a module of one that reduces. A module of five functions adds 1.8 kB.
The option is off by default for that reason. A module built without it works as before, and every
call of a scope runs apart:
`add and mul run as two dispatches because mul was built without typeshade({ fuse: true })`.

**Entries and tiles.** A compute entry call is recorded as a group of its own.
A tiled or workgroup entry retains its barriers and dispatch shape in that group.
Its runtime-sized storage arrays must be resident, and it cannot write a plain host value.
An indirect entry reports `indirect: true`; the device reads its count buffer after earlier calls.
The host reads no scheduling word between these calls.

**The body.** `fuse(body)` runs `body` once, and the body is synchronous. A kernel call in the body
is recorded, and not run, when every array it writes is a `Resident`. A scratch array is a
`Resident`. A recorded call may read a typed array, and it reads its arguments when the plan runs.
It returns the promise that the call returns outside a scope, which resolves once the plan has run.
Keep a promise you need, and await it after `fuse` resolves: `sum = total(u)` in the body, and
`await sum` after it. `scope.recorded` counts the calls recorded so far.

**When the plan runs.** When the body returns, the plan runs as one item of the kernel queue, at the
place where `fuse` was called. The calls made before `fuse` run before the plan. A call or a
`read()` made after `fuse` was called sees what the plan wrote, whether or not its promise has
resolved. The promise resolves to the report, and rejects with the first error. The runtime checks
every recorded call before it runs the first one. A call that fails its check fails the plan before
any call runs, and the error stays on each `Resident` that the plan writes, for `read()` to throw.

**What fuses.** On WebGPU the plan walks the calls in the order the host made them. A call joins the
group before it when all of these hold against every call in the group, and not against the last
one alone. A group of several calls is one dispatch.

- The function lowers to the GPU (a `TS8070` warning means it does not), was built with the option,
  and has one `for` loop at the top of its body. The loop does not scatter into an integer array,
  has no `continue`, and runs at least one iteration.
- The loops start at the same index, run the same number of iterations and step by the same amount.
  The runtime works the range out for each call from its arguments, so a chain can fuse for one
  length and not for another.
- An array that a call in the group wrote and this call reads is written and read at exactly the
  loop's counter, `out[i]` and `t[i]`. A read of `t[i - 1]` or `t[i ^ 1]`, and a write to
  `out[2 * i]`, keep the calls apart.
- This call writes no array that a call in the group reads or writes. Two calls may read one array.
  One array has one type in a group.
- The group binds each distinct array once, and one more for each variable that a reduction at its
  end folds. A device allows `maxStorageBuffersPerShaderStage` of them, and 8 where it reports no
  limit. A scratch array that the entry holds as a local counts for none, once the last call that
  names it has joined.
- A loop that reduces can be the last call of a group. The calls before it run as a prologue of each
  of its iterations. Nothing joins a group after it, and a reduction alone is not fused.

A call that joins no group starts a group of its own. The results are the same either way.

**The report.** `fuse` resolves to a `FuseReport`:

- `tier` is the best tier that any call of the plan ran on: `'webgpu'`, then `'webgl2'`, then
  `'cpu'`.
- `dispatches` counts the dispatches the plan made on WebGPU, or the draws on WebGL2. A fused group
  counts once.
- `submissions` counts the `queue.submit` calls of the plan, and the reads of a `Resident` from the
  device that a call on the host needed.
  The copy of a folded value is in a submission that is counted already, and adds none.
- `groups` lists the groups in order. Each has its `calls`, the names of its kernel functions, and
  `fused`, whether it is one dispatch. A group that stands apart from the one before it also has a
  `why`.

**The `why`** is `a and b run as two dispatches because` and a reason, in your names. An access that
is not at the counter is given as you wrote it, with its one-based line:
``mul and blur run as two dispatches because blur reads `t[i - 1]` (line 9)``. Some other reasons:

- `b was built without typeshade({ fuse: true })`
- `b has more than one loop`, `b scatters` and `` b has a loop with a `continue` ``
- `a reduces`, for a call that follows a reduction
- `the trip counts differ (1000 and 999)` and `the loops start at different indices (0 and 1)`
- `b writes an array a also writes` and `b writes an array a reads`
- `one dispatch would bind 9 storage buffers, and the device allows 8`

A function that runs on the CPU gives a whole sentence:
`prefix runs on the CPU, a loop of it runs on the CPU (TS8070)`. The first group has no `why`.

**Scratch arrays.** `scope.scratch(length)` makes a scratch array, an intermediate that the host
never reads. `scope.scratch(n, 'i32')` and `scope.scratch(n, 'u32')` make an `array<i32>` and an
`array<u32>`. A kernel call takes it where it takes an array. It holds zeros when the plan starts.
Make it while the body runs.

- A fused group holds it as a local variable of its entry, with no device buffer and no host array,
  when every call of the plan that names it is in that group, exactly one call of the group writes
  it, every access is at exactly the loop's counter, and no call reads its `.length` anywhere but
  in the bound of its `for` header (`i < out.length`).
- Otherwise the plan makes a zeroed array for the scope, and frees it when the plan has run, on
  success and on failure.
- `read()` rejects with a `TypeError`, and `write()` throws one. `destroy()` does nothing. A kernel
  call that takes it outside the body that made it, or after the plan has run, is a `TypeError`.
- A `Resident` from `resident()` keeps its buffer and its write inside a fused group, so the host
  can read it after the scope.

**A reduction at the end.** `total(u)` as the last call of a scope takes the calls before it into
its own loop. Its folds of the partials and its result are the ones the call has outside a scope, so
the sum is the same on every tier. The loop's dispatch and each dispatch that folds a level of
partials are in the plan's one submission, and the same submission copies the folded value. The
three calls `add`, `mul` and `total` over 1,000 elements report 2 dispatches and 1 submission.

**The tiers.** Only WebGPU fuses. The arrays and the results are the same on every tier.

- On WebGL2 each loop is a draw, as it is outside a scope. `dispatches` counts the draws,
  `submissions` is 0, and the `why` of each group but the first is `WebGL2 runs the calls apart`.
- The CPU tier runs the calls one after another. `dispatches` and `submissions` are 0, and a group
  whose function lowers has no `why`. The CPU tier is the oracle of a fused group.
- `configure({ prefer })` orders the tiers of each call as it does outside a scope.

**Refusals.** A call that cannot be recorded throws a `TypeError` that names it, because it would
run before the calls recorded earlier. Call it outside `fuse`. These are the calls:

- a kernel call that writes a typed array:
  `add(): parameter "out" is a Float32Array, and a call inside fuse() writes only a Resident.`
- a draw, which cannot be recorded in a compute plan.
- `read()`, `write()` and `destroy()` of a `Resident`, and every other use of the kernel queue.

An `async` body is a `TypeError` too, since a call after its first `await` would run outside the
scope. A body that throws leaves nothing to run, and `fuse` rejects with its error. A `fuse` call in
the body joins the scope that is open and returns the report of that scope.

`docs/use-typeshade-surface.md` §71 in `typeshade/typeshade` has every reason and every wording.

## Common modules

Prefer `typeshade/algorithms` for copy, fill, maps, reductions, scan, compaction and histogram (§72).
Prefer `typeshade/random` for seeded generators (§73).
Host code imports these subpaths and calls their functions over arrays, alone or within `fuse`.
A shader imports the same subpaths under the `typeshade` package condition.
Shader unary maps use names such as `absMap`; host exports use `abs`. Shader reductions include `maxAll` and `minAll`.
Both faces run the same TypeShade source. The CPU oracle defines the result on each supported tier.
Random generators use counter-based ids and a seed, so fusion and dispatch partitioning preserve their output.
Check each operation's tier support. Scans and compaction can fall back from WebGL2; histograms require atomics on WebGPU.

## Key values and collections

A helper or kernel value parameter converts a key string to its id before execution and converts results back afterward.
A `Record` value parameter is an object with every member and no extra property.
Entry bindings and runtime-sized kernel arrays still use numeric ids and arrays in id order (0081 D1 remains open).
A kernel `Map` or `Set` takes the host's JavaScript collection and updates it in place.
String-key collections convert keys before and after the loops; unknown strings throw `TypeError`.
Insertion order is preserved, and Map keeps the value last set for each key.

## The program runtime

A module's default export is its compiled program, the manifest (`Pack`), and
`packModule(compile(source).module)` returns the same object. `typeshade/runtime` loads it and
runs it on WebGPU or on WebGL2, and imports nothing of the compiler, so an application ships about 10 KB of it.

```ts
import { createRuntime } from 'typeshade/runtime'
import particles from './particles.shade.ts' // the manifest

const rt = await createRuntime({ programs: [particles] }) // or { device }, the host's own
const step = await rt.load(particles).compute('step')
const frame = rt.frame()
frame.dispatch(step, { params: { dt: 0.016 }, particles: gpuBuffer }, 64)
await frame.submit() // the console lines print here
```

- **The device** is the host's, `createRuntime({ device })`, which the runtime never destroys, or
  one it requests with the features `programs` need. `runtime()` is the default runtime, on the
  device the imported module's calls use.
- **A program** is `rt.load(manifest)`, refused for another schema or a feature the device lacks.
  `program.compute(entry)` and `program.render(state)` resolve to cached pipelines laid out from
  the manifest; `state` holds the colour targets, depth, topology, culling and multisampling.
- **Overrides by name.** `render({ targets, constants: { quality: 3 } })` and
  `compute('step', { constants: { iterations: 64 } })` set the program's overrides; one left out
  keeps its default. An unknown name, or a value its type cannot hold, is a `TypeError`; each set
  of values is its own cached pipeline. A host can choose a workgroup size from ordinary
  TypeScript, then pass it to the override used by `@compute` and a workgroup array:

  ```ts
  const selectedSize = input.length >= 256 ? 256 : 64;
  const pipeline = await program.compute('copy', { constants: { WG_SIZE: selectedSize } });
  const groups = Math.ceil(input.length / pipeline.workgroupShape[0]);
  frame.dispatch(pipeline, { src: input, dst: output }, [groups, 1, 1]);
  ```

  `workgroupShape` is the resolved `[x, y, z]` shape for that pipeline. Use it when deriving the
  dispatch count. WebGL2 supports the declared default shape; a different specialized shape is
  refused because WebGL2 cannot specialize workgroup dimensions.

- **A texture's layout** follows the calls that read it: one a program only loads is
  `unfilterable-float`, so an `r32float` texture binds; one a sampler reads takes a filterable
  format.
- **Bindings go by name**, `{ name: value }`: a plain host value, packed by the binding's layout;
  a `Resident`; a `Texture` or `Sampler` from `rt.texture()` and `rt.sampler()`; or the host's
  own `GPUBuffer`, `GPUTexture` or `GPUSampler`. An unknown name, a missing binding and a value of
  the wrong shape are a `TypeError` naming the entry, its line and the binding.
- **Host bindings are checked from the module view.** The generated `name.shade.typeshade.ts` view
  gives each compute and render entry the bindings its shader reaches, so `tsc` can catch a missing
  or misspelled binding. A manifest read from JSON has no static binding type; cast it to
  `Pack<BindingsOf<typeof module, 'entry'>>` for the entry it names.
- **Geometry may stay resident.** `Geometry.vertices` accepts a `Resident<Float32Array>`,
  `Resident<Int32Array>` or `Resident<Uint32Array>`. `Geometry.indices` accepts a
  `Resident<Uint32Array>`; its index format is `uint32`. Both remain on the device after their
  first upload.
- **A frame** is one encoder: `frame.dispatch()`, `frame.pass(targets, record)`, then `submit()`,
  which resolves to `{ console: [{ entry, lines, dropped }, …] }`, a row per dispatch or draw that
  recorded.
  A host with encoders of its own records with `pipeline.dispatch(encoder, …)` and
  `pipeline.draw(pass, …)` and submits with `rt.submit(encoder)`.
- **One device for both layers.** `configure({ runtime: rt })` puts the imported module's calls on
  `rt`'s device, so a `Resident` or a `Texture` made on either is used on the other.
- **The console.** A program loaded with its recorded variant, `rt.load(m, { console: true })`
  (the default when the manifest carries one), prints each event after the submit that ran it, or
  hands it to `createRuntime({ console: sink })`.
- **The load-time emitter.** `createRuntime({ emit: repack })`, with `repack` from
  `typeshade/emit`, records the console of a program whose build did not, from the IR the
  manifest carries when built with `ir: true`. Only the package version that wrote the IR reads
  it.
- **The fuse scope.** `fuse` from `typeshade/fuse` stands beside `typeshade/emit`. A host imports it
  on purpose: the package root and `typeshade/runtime` export no `fuse`, so an application that
  never imports the subpath ships none of the planner. The subpath holds the planner and the WGSL
  writer, with no file of the front end and no `typescript`: about 74 KB, minified and gzipped,
  held to a budget in CI. The section "A chain of kernel calls in one dispatch" has its use.
- **Reading a texture back.** `texture.read()` gives its bytes, rows tightly packed, for any
  uncompressed format and `depth32float`; `texture.readFloats()` gives the same channels as numbers
  (a float format decoded, `unorm` 0 to 1). Either reads what was submitted before the call.
- **The tier.** `rt.tier` is `'webgpu'` or `'webgl2'`. The runtime runs on the tier of the device it
  is given, and `createRuntime({ prefer })` orders the tiers when it makes one. It has no CPU tier,
  and `configure({ runtime })` takes no WebGL2 runtime.

## compile() and reflect()

```ts
import { compile, reflect } from 'typeshade'
import { existsSync, readFileSync } from 'node:fs'

// A file's text, or undefined: how the compiler reads the shader files tint.shade.ts imports.
const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)
const result = compile(read('src/tint.shade.ts')!, {
  fileName: 'src/tint.shade.ts',
  readDocument: read,
})

const errors = result.diagnostics.filter((d) => d.category === 'error')
if (errors.length > 0) {
  // Positions in diagnostics are one-based.
  throw new Error(errors.map((d) => `${d.fileName}:${d.line}:${d.character} ${d.code} ${d.message}`).join('\n'))
}

const wgsl = result.wgsl! // every entry point; pick one by name in the pipeline descriptor
const glsl = result.glsl // { vertex, fragment } or undefined
const layout = reflect(result.module)
```

- `readDocument` reads each import by the path it resolves to against `fileName`, and each
  `package.json` the compiler looks for to find a package an import names. Without it an import
  is `TS8072`. A diagnostic located in an imported file carries that file's `fileName`, line and
  column.
- `wgsl` is `undefined` whenever a diagnostic is an error, and holds every entry point otherwise.
- `glsl` is `{ vertex, fragment }` in GLSL ES 3.00, or `undefined` for a compute-only module or
  one that uses something GLSL has no form for (a `TS8015` warning says what).
- `module` is the compiler's IR, always present (partial when there is an error).
- `determinism` lists the operations whose results may differ between GPUs.
- `eval(name, args)` runs a function on the CPU, in double precision; it throws when the module
  has an error.
- `reflect(module)` returns `bindGroups[].entries[]` (`group`, `binding`, `name`, `space`,
  `access`, `resourceKind`, `structName`, `stages`), `uniforms[]` and `storage[]` layouts with
  every field's `offset` and `size`, `entries[]` with their stage inputs and outputs,
  `overrides[]`, and `requiredFeatures`.

## WebGPU

- `device.createShaderModule({ code: wgsl })`, then name the entry point in the pipeline
  descriptor (`entryPoint: 'vs'`).
- Every resource is in group 0, at the binding the reflection reports; `layout: 'auto'` works
  too.
- Pack a uniform buffer at the `offset` of each field in `reflect(...).uniforms`. Never by hand:
  a `vec3` aligns to 16 bytes, and a `mat3` has padded columns.
- Overrides are pipeline constants: `constants: { tint: 1.2 }`.
- A compute dispatch covers the data in workgroups: `ceil(n / 64)` for `@compute([64])`.
- A fullscreen pass that builds its triangle from `vertex_index` is `draw(3)` with no vertex
  buffer.

## WebGL2

- Compile `glsl.vertex` and `glsl.fragment` as the two shaders of one program.
- A uniform block is named after the struct type and its instance after the binding:
  `layout(std140) uniform Frame { ... } frame;`, so `gl.getUniformBlockIndex(program, 'Frame')`.
- A texture and the sampler it is used with become one `uniform sampler2D` named after the
  texture.
- Vertex attributes are `layout(location = N) in ... a_<field>`.
- An override becomes `#ifndef NAME` / `#define NAME <default>`, replaceable before compiling.
- The fragment `@builtin("position")` has its y origin at the bottom on WebGL2 and at the top on
  WebGPU; flip per target if the shader uses `.y`.

## Checking without the MCP server

When the typeshade MCP tools are not connected, compile the file with the project's own copy of
the compiler. Run it with a TypeScript runner such as `tsx`, which works whether the project has
the compiler from npm or as a git submodule (whose sources are TypeScript):

```bash
npx tsx -e "
import { compile } from 'typeshade'
import { existsSync, readFileSync } from 'node:fs'
const file = process.argv[1]
const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : undefined)
const r = compile(read(file), { fileName: file, readDocument: read })
for (const d of r.diagnostics) console.log(d.fileName + ':' + d.line + ':' + d.character, d.category, d.code, d.message)
process.exit(r.diagnostics.some((d) => d.category === 'error') ? 1 : 0)
" src/tint.shade.ts
```

`compile()` reports the compiler's own diagnostics. The editor's (the language service's) add
TypeScript's type errors on top, minus the ones that are false for shader code, which is what
the MCP server's `check` returns.

## Editor noise and compiler truth

- Plain `tsc` over a shader file (with `lib: []` and `types: ["typeshade/shade"]`) reports
  `TS1206` on every stage decorator and `@builtin` parameter, and `TS2362`, `TS2365` or `TS2345`
  on vector arithmetic, because TypeScript has no operator overloading. Both are expected.
  **`compile()` is the authority.** Annotating a local (`const c: vec3 = a * s`) quiets the
  editor without changing the emitted code.
- The TypeShade tsserver plugin (`typeshade/vscode-typeshade`) gives VS Code, Cursor and every
  other tsserver-based editor the service's answers instead of TypeScript's.
