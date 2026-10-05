# Compiler changes this repository has handled

A change to the compiler that alters what these packages, the skill or the docs describe is
agreed first as a proposal in the compiler's `changes/` directory (the compiler's
`changes/README.md` explains the process). Each proposal lists, under `downstream`, the work it
will owe this repository.

When a pull request moves the compiler pin (`vendor/typeshade`) past a proposal that names
`vscode-typeshade`, `scripts/downstream-impact.ts` fails the pull request until the proposal's
work is done on that branch and its id is recorded below. Record one list item per proposal: the
id first, then the pull request that did the work.

- 0001: a `for` loop takes a runtime bound and `while` is an open loop: the skill's TS8006
  example and loop advice, and the MCP run tool's step budget, handled in #14.
- 0005: an array's `map`, `forEach`, `some`, `every` and `reduce` compile: the skill's sentence on
  JavaScript array methods and its TS8099 row, the array-methods line and the refusals row of
  references/language.md, and the TS8099 row of references/diagnostics.md, handled in #20.
- 0006: a storage binding's access mode is its second type argument: the skill's binding rule
  and its three examples (SKILL.md, references/language.md, references/examples.md), the TS8005
  and TS8099 rows, the MCP server's KERNEL fixture, and the outline test that reads the access
  mode off the resource line, handled in #20.
- 0007: one diagnostic per mistake, with its fix in it, and switch fall-through refused: the
  skill's working loop and its TS8022 row, the first-error paragraph and the TS8017 and TS8022
  rows of references/diagnostics.md, the switch line of references/language.md, the TS2304 and
  TS8004 note of `docs/design.md` §6, the MCP server's `FOREIGN_NAMES` (the compiler's now, with
  `docs` answering in `foreignNameRemedy`'s words) and its `check` (the compiler's
  `checkOpenDocument` now), `docs/agents.md` §3.1 and §3.5, and the three tests that counted
  TypeScript's TS2304 beside TS8004, handled in #24.
- 0008: a diagnostic says what the program is: references/diagnostics.md drops the TS8012 row,
  its TS8013 row stops listing `new`, which the TS8035 row takes (`new vec3f(...)`, a function,
  an enum, an interface, an abstract class), and its TS8014 and TS8022 rows name a top-level `var`
  and a JavaScript global; references/language.md's top-level `var` line says `TS8014` alone,
  handled in #31.
- 0009: a host file imports a `.shade.ts` through `typeshade/vite` and a generated host view:
  the skill's compiler-only claims (SKILL.md intro, description and host section,
  references/host.md) rewritten around the import; docs/design.md §1.4 (the name is the rule for
  a host import), §1.6 (the host reads the view through `moduleSuffixes`), §1.8 and §8 items 5
  and 9 (`createShaderTsconfig` prints `moduleSuffixes` beside the `exclude`), the preview-scope
  reason; `HOST_IMPORT_PROJECT`, a tsserver fixture for a host file that calls an export with
  vector arguments, handled in #26.
- 0011: WGSL's `matCxRf` aliases are types and constructors: the type table in
  references/language.md names `mat4x4f` beside the other matrix spellings, handled in #25.
- 0012: a `"use typeshade"` directive after another statement is `TS8069`: a `TS8069` row in
  references/diagnostics.md, and the `TS8001` row, which now means no directive at all, handled in
  #25.
- 0014: `console` calls reach the host from WebGPU under `console: 'gpu'`: the skill's
  `console.log` rule (SKILL.md) and its line in references/language.md rewritten around labels and
  the opt-in buffer, the binding rule noting the compiler's `_fp64` and `_console` after the
  author's, a `TS8071` row in references/diagnostics.md, and docs/design.md §5's DAP table gaining
  the `output` row for a console call, pending the stepping engine's sink, handled in #25.
- 0018: a debug session delivers the `console` calls it steps over to a sink: docs/design.md §5's
  DAP row for a console call no longer pending, and the MCP server's `run` tool printing the
  lines a run logged under its result (`tools.test.ts` pins the output), handled in #26.
- 0019: a shader calls `console.table` with one value: the skill's console rule (SKILL.md) and
  references/language.md name `table` and its one argument; the MCP server's `run` tool prints a
  `table` event as indented rows (`tools.test.ts` pins an array of structs and a matrix);
  docs/design.md §5's DAP `output` row says how a `table` event reads, handled in #28.
- 0022: a `"use typeshade"` file imports what another exports, and every path follows the
  import: the tsserver test's call across two shaders reports nothing, the TS2305-after-rename
  assertions (tsserver.test.ts, documents.test.ts, the MCP server's tools.test.ts) expect the
  compiler's TS8072, and a new tsserver case pins the one TS8072 on an import of a plain module;
  SKILL.md's rule 10 (imports, `TS8072`, `readDocument`), its intro, binding rule, TS8004 and
  TS8072 rows and `compile()` snippet; references/language.md's import section and its two-file
  example, which skill.test.ts compiles as one program, its slots line and its `new` row;
  references/diagnostics.md's TS8004 and TS8072 rows; references/host.md's `compile()` recipes,
  which pass a `readDocument`, and the Vite plugin following imports; the MCP server's `compile`
  and `run`, which read imports through the workspace, print a diagnostic at the file it is
  located in and take `run`'s breakpoints as lines of the file named, with the fixture that
  imported `double` now calling it; the extension's reflection, entry list and Run Entry, which
  compile with a `readDocument` and rebuild when an imported file changes, and its reader, which
  serves an open editor's text or the file on disk when it carries the directive;
  docs/design.md §1.7, §4, §5's `launch` and `setBreakpoints` rows, §6 and §8 item 3, and
  docs/agents.md §2, §3.3, §4 and §8 item 3, handled in #31.
- 0016: a host file calls a `@compute` entry and draws a full-screen `@fragment` entry through
  the host view: the skill's host section (SKILL.md) gains the draw beside the helper call and
  the entry call, and references/host.md says how the bindings object is typed, what a
  `Resident` keeps on the device and in what order the calls run, where an entry runs and what
  `configure` orders, and what a draw draws into and on which tier; `HOST_IMPORT_PROJECT` gains a
  compute module, a fragment module, the views the pin writes for them and `gpu.ts`, which the
  tsserver test type-checks with the pinned compiler linked as `node_modules/typeshade`, a missing
  binding and a missing uniform field being TypeScript's own TS2769 and TS2741; docs/design.md's
  host-side paragraph says what the fixture pins, handled in #32.
- 0023: the compiler's command is `tshc`: `HOST_IMPORT_PROJECT`'s terrain view opens with the line
  the pin writes (`tshc sync` rewrites it); the skill's host section and references/host.md say
  `tshc sync`; docs/design.md's host view paragraph and docs/agents.md §3.1 say `tshc sync` and
  `tshc check`, and so do the MCP server's comments in format.ts and tools.ts, handled in #32.
- 0013: a top-level loop of an exported function that takes an array runs as a GPU kernel when the
  compiler proves its iterations independent: the skill's compute section (SKILL.md) gains the
  kernel function beside the `@compute` entry, with an example the skill test compiles, and its
  host section the call; references/host.md says what a kernel function is, how the call is
  typed and awaited, what a `Resident` of its array does, and which tier runs it;
  references/diagnostics.md's `TS8070` row already said what the pin says; `HOST_IMPORT_PROJECT`
  gains a module of kernel functions, the view the pin writes for it and `kernel.ts`, which the
  tsserver test type-checks with a `Float32Array` (a promise) and with a `Resident` (`void`), and
  the fixture's other views take the default export every view now carries, handled in #33.
- 0024: a shader file imports a package's shader module by the package's name: the readers
  that served only a file beginning with the directive serve a `package.json` too (the
  extension's `shaderReader`, and `DocumentSync.readDocument`, which the tsserver plugin and the
  MCP server share, reading it through the host's `readFile`); SKILL.md's rule 10 and its TS8072
  row; references/language.md's import section with a package's `exports`, its stem line and its
  TS8072 list; references/diagnostics.md's TS8072 row; references/host.md's plugin and
  `readDocument` lines; a tsserver case, a `documents.test.ts` case, two `model.test.ts` cases and
  a `tools.test.ts` case that import a fixture package; docs/design.md §1.7, handled in #34.
- 0027: WebGL2 gives WGSL's answer for integer division, remainder and shift, and for a float's
  conversion: references/language.md's conversion line drops "GLSL leaves an out-of-range value
  undefined, so clamp first" and says a float converts the same way on every target, handled
  in #39.
- 0025: the program runtime and its load-time emitter: references/host.md gains the program
  runtime (`typeshade/runtime`) beside the import and `compile()`, says the calls request a device
  or use the runtime's under `configure({ runtime })`, and gains the printed console line and the
  plugin's `console` and `ir` options, and SKILL.md points to it; the MCP server's `run` tool
  prints each logged line in the host console's form, the tier, the file and line and the
  invocation, which `tools.test.ts` pins; docs/design.md §4 records that the runtime gives a
  preview its own device and binds by name, and docs/playground-bridge.md §3 that 0025 is at the
  pin, handled in #40.
- 0028: what the program runtime's first hosts need: references/host.md's program runtime
  section names the override values `render()` and `compute()` take, the texture layout the
  calls that read a texture decide, the console's counts `submit()` resolves to, and `read()` and
  `readFloats()`, handled in #48.
- 0035: a class with no instance fields is a value: references/language.md's class section says
  that `class Empty {}`, a class of methods or getters only and a class of static members are
  built with `new`, that the host and a CPU run see `{}`, and that the GPU code carries a hidden
  `u32`; its class example builds a class of methods only. No skill text or fixture here refused
  such a class, handled in #51.
- 0036: an unannotated local integer takes its type from the declared parameter of a call it is
  passed to: SKILL.md's rule 1 and references/language.md's literals section name the declared
  use, and say that an index decides nothing, so rule 1's `TS8003` example stands; an MCP
  `tools.test.ts` case checks a local `-1` passed to an `i32` parameter as clean and hovers it as
  `let objectIndex: i32`, handled in #51.
- 0037: the declared use extends to a constructor, a method and a typed assignment: SKILL.md's
  rule 1 and references/language.md's literals section name them and the `TS8003` of uses that
  disagree; references/diagnostics.md's TS8003 row gains that cause; the tsserver fixture
  `references.shade.ts` passes `-1` to a constructor whose parameter declares `i32`, and the
  hover test reads the local's type there, handled in #51.
- 0038: a derived class value goes where its base is declared when the compiler proves the base
  view read-only: references/language.md's class section says when, and that there is no
  runtime dispatch through a base type, with a compiled example of the accepted case and an
  `expect: TS8003` example of an override the proof refuses; references/diagnostics.md's TS8003
  row names the refusal and its remedy, handled in #51.
- 0039: a parameter or a local may shadow a module value: references/language.md's scope line
  says so, with the example of a local `u` beside a uniform `u`, and that a local that repeats a
  parameter is still `TS8023`; references/diagnostics.md's and references/language.md's TS8023
  text says "in one scope". No text here told an author to rename for a module value, handled
  in #51.
- 0040: parameters declared `@inout` and `@out`, with unmarked arguments (the third amendment;
  the `Ref<T>` and `ref()` of the earlier text never reached a pin here, so nothing named them):
  the tsserver plugin answers `provideInlayHints` for a directive file with `&` at each argument
  such a parameter takes, computed from the syntax in `packages/tsserver-plugin/src/inlay.ts`,
  since the compiler delivers no inlay hint (its deviation 7), with `inlay.test.ts` and a
  tsserver case; the tsserver and MCP hover tests read the compiler's hover of a qualified
  parameter (`(parameter) @inout w: f32`) and of its function, which the plugin passes through
  unchanged; the MCP `docs` tool answers `@inout` and `@out` from the compiler's attribute table
  with no change to the server, and a test pins that and that `in`, `Ref` and `ref` are no
  names; a `run` test runs a function that passes variables to both; SKILL.md's rule 5
  (parameter writes, the qualifiers, `TS8073`, `TS8074`, no `@in`) with a compiled example, its
  local-function sentence and its TS8018 and TS8073 rows; references/language.md's parameter
  line and a new section on the qualifiers with a compiled example and an `expect: TS8073`
  example; references/diagnostics.md's TS8018 row and its TS8073 and TS8074 rows, and an
  `@inout` fix of the TS8018 example; docs/design.md §3 (the `provideInlayHints` row, the
  paragraph on what the hint resolves and its limits), §6 and §8 item 13; the extension's
  CHANGELOG, handled in #51.
- 0043: a read of a local before it is assigned is the compiler's `TS8075`, and every target
  starts a local at zero: references/diagnostics.md gains the TS8075 row, an `expect: TS8075`
  example and its fix, and says that TS2454 is the compiler's TS8075 now; SKILL.md's diagnostics
  section says the same and gains a TS8075 row; references/language.md's `let x: f32` line says
  that GLSL now writes the zero; the tsserver test reports `typeshade(8075)` once on a read
  before an assignment and nothing on an `@out` argument, and the MCP `check` test the same,
  handled in #51.
- 0044: `bitcast` takes a vector, `bitcast<vec4u>(v)` and `bitcast<vec4>(w)`:
  references/language.md's bitcast line names the vector forms and the width refusal, handled in
  the pull request that pins the compiler at fd39ba3.
- 0045: a NaN or subnormal `f32` word has no portable `bitcast`: references/language.md says to
  keep integer words in a `storage<array<u32>>` or `storage<array<vec4u>>` binding, handled in the
  same pull request.
- 0047: `array<T, N>()` is the zero value of a fixed-size array: references/language.md's
  Constructors line names `array<u32, 32>()` beside `vec3()`, handled in the pull request that
  pins the compiler at e56b886.
