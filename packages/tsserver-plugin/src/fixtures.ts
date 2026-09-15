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
`

/** The same shader with its directive removed, for the transition that only `closeDocument` can
 *  handle: the file stays in the project, so no prune reaches it. */
export const CLEAN_WITHOUT_DIRECTIVE = CLEAN.replace('"use typeshade"\n', '')

/** A shader with a real TypeShade error: a call to a function that does not exist, which the
 *  front end reports as `UNKNOWN_FN` (TS8004). */
export const BROKEN = `"use typeshade"

@fragment
export function fs(): f32 {
  return nope(1.)
}
`

/** A shader with a parse error, for the assertion that one broken paren is underlined once. */
export const SYNTAX = `"use typeshade"

@fragment
export function fs(): f32 {
  return vec4(1., 0.
}
`

/** The imported half of the pair. */
export const LIB = `"use typeshade"

export function double(x: f32): f32 {
  return x * 2.
}
`

/** The importing half. The specifier is `./lib.shade.js`, not `./lib.js`: the service resolves
 *  a relative import by rewriting a trailing `.js` to `.ts`, so `./lib.js` would look for
 *  `lib.ts` and find nothing. */
export const MAIN = `"use typeshade"

import { double } from './lib.shade.js'

@fragment
export function fs(): f32 {
  return double(2.)
}
`

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
`

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
`

/** A shader with an import it does not use, so `organizeImports` and `getPasteEdits` have
 *  something to do. On `broken.shade.ts` they answer empty from both servers, which made the
 *  assertion about them true without the plugin. */
export const UNUSED_IMPORT = `"use typeshade"

import { double } from './lib.shade.js'

@fragment
export function fs(): f32 {
  return 1.
}
`

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
`

/** A host file that imports a shader, which is the §1.6 case: the host side stays plain
 *  TypeScript and the plugin does not touch it. */
export const HOST_IMPORTS_SHADER = `import { fs } from './clean.shade.js'

export const entry = fs
`

/**
 * A shader of at least `lines` lines, which is what puts it past tsserver's 500-line region
 * diagnostics threshold.
 *
 * @param lines - the least number of lines wanted.
 * @returns the shader's text.
 */
export function longShader(lines: number): string {
  const parts = ['"use typeshade"', '']
  for (let i = 0; parts.length < lines; i++) {
    parts.push(`export function h${i}(x: f32): f32 {`, `  return x * ${i + 1}.`, '}', '')
  }
  parts.push('@fragment', 'export function fs(): f32 {', '  return h0(1.)', '}')
  return parts.join('\n')
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
)

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
}

/** A workspace with no `tsconfig.json` at all, which is how most people first open a shader:
 *  tsserver puts the file in an inferred project, whose constructor calls `enableGlobalPlugins`
 *  (`typescript.js:184978`), so the plugin is enabled there too. */
export const INFERRED_PROJECT: Readonly<Record<string, string>> = {
  'clean.shade.ts': CLEAN,
}
