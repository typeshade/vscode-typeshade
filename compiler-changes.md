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
