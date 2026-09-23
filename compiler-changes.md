# Compiler changes this repository has handled

A change to the compiler that alters what these packages, the skill or the docs describe is
agreed first as a proposal in the compiler's `changes/` directory (the compiler's
`changes/README.md` explains the process). Each proposal lists, under `downstream`, the work it
will owe this repository.

When a pull request moves the compiler pin (`vendor/typeshade`) past a proposal that names
`vscode-typeshade`, `scripts/downstream-impact.ts` fails the pull request until the proposal's
work is done on that branch and its id is recorded below. Record one list item per proposal: the
id first, then the pull request that did the work.

- 0001 — a `for` loop takes a runtime bound and `while` is an open loop: the skill's TS8006
  example and loop advice, and the MCP run tool's step budget, handled in #14.
