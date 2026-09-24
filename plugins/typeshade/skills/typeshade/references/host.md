# TypeShade on the host side

A host uses a shader module one of two ways:

- **It imports the module** through the `typeshade/vite` plugin and calls its exports. A helper
  runs on the CPU. A `@compute` entry dispatches on WebGPU, and a full-screen `@fragment` entry
  draws into a canvas. The runtime creates the device and the pipelines.
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

Add `"prepare": "typeshade sync"` to `package.json` and `*.shade.typeshade.ts` to `.gitignore`.
The plugin writes a host view, `name.shade.typeshade.ts`, beside each module, and
`moduleSuffixes` makes `tsc` and the editor read it in place of the source. `typeshade sync`
writes every view before `tsc` runs on a clean checkout.

```ts
import { height } from './terrain.shade.ts'
import { scale } from './kernels.shade.ts'

const k = [1, 0.5, 2, 0.25] as const
const h = height([0.5, 0.5], k) // a number
await scale({ k: 2.5, xs, ys }, 4) // four workgroups; ys, a Float32Array, is filled in place
```

- **A helper** a host can call is exported, not generic, takes no function, and reaches no
  binding, workgroup variable or GPU-only builtin. It runs on the CPU at f32, synchronously.
- **A `@compute` entry** is `entry(bindings, workgroups)`. The promise resolves once every
  storage binding it writes has been read back into the caller's value. It runs on WebGPU, and
  on the CPU where there is none (Node). An entry that reaches a barrier needs WebGPU.
- **A full-screen `@fragment` entry** is `entry(canvas, bindings)`. It draws one frame on WebGPU,
  then WebGL2, then the CPU.
- Every other export is `never` in the view, with the reason, so calling one is a type error.
- **Host values:**
  - a number for a scalar, a boolean for a `bool`
  - a tuple for a `vecN`
  - a flat column-major array for a matrix
  - an object for a struct
  - a typed array for a runtime-sized storage array
- The module must be named `*.shade.ts`. A compile error fails the build with its `TS80xx`
  diagnostics.
- In `vite dev`, a `console.*` call in an entry prints in the browser console from the GPU. A
  production build records nothing.

## compile() and reflect()

```ts
import { compile, reflect } from 'typeshade'
import { readFileSync } from 'node:fs'

const source = readFileSync('src/tint.shade.ts', 'utf8')
const result = compile(source, { fileName: 'src/tint.shade.ts' })

const errors = result.diagnostics.filter((d) => d.category === 'error')
if (errors.length > 0) {
  // Positions in diagnostics are one-based.
  throw new Error(errors.map((d) => `${d.fileName}:${d.line}:${d.character} ${d.code} ${d.message}`).join('\n'))
}

const wgsl = result.wgsl! // every entry point; pick one by name in the pipeline descriptor
const glsl = result.glsl // { vertex, fragment } or undefined
const layout = reflect(result.module)
```

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
import { readFileSync } from 'node:fs'
const file = process.argv[1]
const r = compile(readFileSync(file, 'utf8'), { fileName: file })
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
