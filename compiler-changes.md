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
- 0011: WGSL's `matCxRf` aliases are types and constructors: the type table in
  references/language.md names `mat4x4f` beside the other matrix spellings, handled in #PR.
- 0012: a `"use typeshade"` directive after another statement is `TS8069`: a `TS8069` row in
  references/diagnostics.md, and the `TS8001` row, which now means no directive at all, handled in
  #PR.
- 0014: `console` calls reach the host from WebGPU under `console: 'gpu'`: the skill's
  `console.log` rule (SKILL.md) and its line in references/language.md rewritten around labels and
  the opt-in buffer, the binding rule noting the compiler's `_fp64` and `_console` after the
  author's, a `TS8071` row in references/diagnostics.md, and docs/design.md §5's DAP table gaining
  the `output` row for a console call, pending the stepping engine's sink, handled in #PR.
