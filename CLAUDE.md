# Working in this repository with Claude Code

Read `README.md` for the checks and the conventions, `docs/design.md` for the editor packages
and `docs/agents.md` for the MCP server, the skill and the plugin. This file adds what keeps
this repository true to the compiler it wraps.

## The language of the conversation

Answer the owner in Korean, every reply, from the first to the last of a session: a status
report, a question, a summary after a merge. What goes into the repository stays in English as
it is: code, comments, commit messages, pull request titles and bodies, and every document in
the tree.

## The packages and the docs follow the pinned compiler

`vendor/typeshade` is the compiler, pinned as a git submodule (`docs/design.md` §2). A package,
a test or a document that names something the compiler removed is wrong even when the
surface diff was read, so moving the pin is a step with checks, not a memory:

- When a change moves the pin, run
  `bun vendor/typeshade/scripts/downstream-impact.ts --repo vscode-typeshade --submodule vendor/typeshade`
  and fix every line it lists: each one still names an export or a file the new compiler
  removes. It also lists every compiler change proposal the new pin implements that names this
  repository and that `compiler-changes.md` does not record yet: do the work the proposal lists,
  then add its id to that file. Update `docs/design.md` §3's table in the same change if what
  the plugin maps has changed.
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

## Before pushing

Run `npm run check`: it is CI's check job (the build, the type check, eslint, prettier, the em
dash check and the tests), so a push that passes it locally passes there. `.claude/settings.json`
also runs the fast half (prettier, eslint and the em dash check, `scripts/commit-gate.mjs`)
before every `git commit` and blocks the commit while one fails.

## Merging

`main` is protected by a GitHub ruleset: a pull request, a Code Owner review (`.github/CODEOWNERS`)
and the required checks (`typecheck + lint + test (node 20)`, `typecheck + lint + test (node 22)`,
`compiler bump impact`). The repository admin can bypass it, and an agent acting
through the owner's account can too, so the rule is written here:

- Merge only when every required check is green on the pull request's current head. A red
  check is fixed, never bypassed.
- Bypass only the review requirement, and only when the owner has said in the conversation to
  merge that pull request. The owner cannot approve their own pull request, so their go-ahead
  is the review.
- Never push to `main` directly, and never force-push it.
- The ruleset, the secrets and every other repository setting are the owner's to change: an
  agent has no admin access to them. When one must change, write the owner a script for the
  GitHub CLI (`gh auth login`, then `gh api`), in PowerShell, since the owner works on Windows.
  Never ask for a token in the conversation: a token pasted there is a leaked token.
- Each required check is a job's `name:` in `.github/workflows/ci.yml`. Renaming or removing
  that job leaves every pull request waiting on a check that never reports, so the ruleset
  (Settings > Rules > Rulesets > `main`) changes in the same step.
