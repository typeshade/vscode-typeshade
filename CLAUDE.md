# Working in this repository with Claude Code

Read `README.md` for the checks and the conventions, `docs/design.md` for the editor packages
and `docs/agents.md` for the MCP server, the skill and the plugin. This file adds what keeps
this repository true to the compiler it wraps.

## The packages and the docs follow the pinned compiler

`vendor/typeshade` is the compiler, pinned as a git submodule (`docs/design.md` §2). A package,
a test or a document that names something the compiler removed is wrong even when the
surface diff was read, so moving the pin is a step with checks, not a memory:

- When a change moves the pin, run
  `bun vendor/typeshade/scripts/downstream-impact.ts --repo vscode-typeshade --submodule vendor/typeshade`
  and fix every line it lists: each one still names an export or a file the new compiler
  removes. Update `docs/design.md` §3's table in the same change if what the plugin maps has
  changed.
- When you edit inside a `LINT.IfChange` block, edit its `LINT.ThenChange` targets in the same
  commit. `TYPESHADE_DOCS_ROOT=$PWD bun vendor/typeshade/scripts/ifchange.ts` checks this.
- `.claude/settings.json` runs both checks before every `git commit` and blocks the commit while
  one fails. A line of its own in the message, `NO_IFTTT=<reason>`, waives an unmet
  `LINT.ThenChange` and nothing else. Write it only after reading the target: a reviewer relies
  on it.
- CI runs the same checks on every pull request (the `compiler-bump` job in
  `.github/workflows/ci.yml`).

The compiler's `AGENTS.md` (section "Docs follow the code") describes the conventions these
checks come from.
