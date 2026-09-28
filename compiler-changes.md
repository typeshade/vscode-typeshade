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
