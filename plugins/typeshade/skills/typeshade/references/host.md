# TypeShade on the host side

A host uses a shader module one of two ways:

- **It imports the module** through the `typeshade/vite` plugin and calls its exports. A helper
  runs on the CPU. A kernel function's loops run on the GPU when the compiler proves them
  independent. A `@compute` entry dispatches on WebGPU, and a full-screen `@fragment` entry draws
  into a canvas. The runtime creates the device and the pipelines.
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
- **A `@compute` entry** is `entry(bindings, workgroups)`. `bindings` has one property for each
  binding the entry reaches, typed exactly, so a missing or misspelled binding is a type error.
  `workgroups` is `n` or `[x, y, z]`, dispatched as written. The promise resolves once every
  storage binding it writes has been read back into the caller's value. It runs on WebGPU, and
  on the CPU where there is none (Node). An entry that reaches a barrier or reads a texture needs
  WebGPU, and `configure({ prefer })` orders the two tiers.
- **A `Resident`**, `resident(array)` from `typeshade`, stands for a storage array with no size, or
  a kernel function's array, and stays on the device: nothing is read back until `await r.read()`.
  When every binding or array a call writes is a `Resident`, the call only queues and returns
  nothing. Entry calls and kernel calls run in the order they were made, and so does a draw that
  reads a `Resident`, so one call's output can be the next one's input.
- **A full-screen `@fragment` entry** is `entry(canvas, bindings)`, into an `HTMLCanvasElement`
  or an `OffscreenCanvas`. It draws one frame that fills the canvas, on WebGPU, then WebGL2, then
  the CPU, and the first draw into a canvas decides its tier. The promise resolves when the frame
  is submitted, and nothing is read back. An entry that reads a storage buffer has no WebGL2 tier,
  and one that reads a texture has no CPU tier.
- Every other export is `never` in the view, with the reason, so calling one is a type error.
- **Host values:**
  - a number for a scalar, a boolean for a `bool`
  - a tuple for a `vecN`
  - a flat column-major array for a matrix
  - an object for a struct
  - a typed array for a runtime-sized storage array, or an array of objects for one of structs
  - an image source (`ImageBitmap`, `ImageData`, an image, a canvas or a video) for a
    `texture_2d<f32>`, and `{ filter, address }` or nothing for a `sampler`
- The module must be named `*.shade.ts`. A compile error fails the build with its `TS80xx`
  diagnostics.
- A module that imports another shader module ([language.md](language.md)) is compiled with it:
  the plugin reads each file the module imports from disk, and `vite dev` rebuilds the module
  when one of them changes. The view holds the module's own exports and what it re-exports.
- In `vite dev`, a `console.*` call in an entry prints in the browser console from the GPU. A
  production build records nothing.

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

- `readDocument` reads each import by the path it resolves to against `fileName`. Without it an
  import is `TS8072`. A diagnostic located in an imported file carries that file's `fileName`,
  line and column.
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
