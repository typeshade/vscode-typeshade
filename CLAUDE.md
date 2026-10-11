# Working in this repository with Claude Code

Read `README.md` for the checks and the conventions, `docs/design.md` for the editor packages
and `docs/agents.md` for the MCP server, the skill and the plugin. This file adds what keeps
this repository true to the compiler it wraps.

## The language of the conversation

Answer the owner in Korean, every reply, from the first to the last of a session: a status
report, a question, a summary after a merge. What goes into the repository stays in English as
it is: code, comments, commit messages, pull request titles and bodies, and every document in
the tree.

## Writing and configuration management

Every reply to the owner and every task follows two disciplines from aircraft maintenance
practice. The writing follows the principles of ASD-STE100, Simplified Technical English. The
work follows the configuration management functions of SAE EIA-649 and ISO 10007. Both are
local conventions, and they claim no compliance or certification.

**Writing.**

- Keep descriptive text and procedures apart. Write a procedure as numbered steps in the
  imperative, with one action in each step.
- Give each sentence one topic. Keep a step to 20 words and a descriptive sentence to 25. Give
  each paragraph one topic.
- Use one term for one thing. Use the exact identifier of each file, symbol, check and command.
- Use the active voice when the actor is known. Do not invent an actor.
- Put a warning before the step it applies to. Name an action that cannot be undone (a merge,
  a force push, a deletion, a release) before it is done.
- Keep facts, inferences, proposals, decisions and observed results apart. Label each one when
  the difference matters.
- A reply in Korean applies these principles in Korean: short sentences, one topic in each, one
  action in each step, the same term for the same thing. ASD-STE100's dictionary is English and
  governs only English text.

**Configuration management.**

- Identification. Name each configuration item by its identifier: a repository, a branch, a
  commit, a pull request, a compiler proposal, the submodule pin, a package version or a
  required check. "The latest" is no identifier. A commit hash is one.
- Baselines. `main` at a commit is this repository's baseline. The pin `vendor/typeshade` is
  its baseline of the compiler. A published package is the build of one tagged commit.
- Change control. Change a baseline only through a pull request. A pin moves only with the
  checks of "The packages and the docs follow the pinned compiler". The approval is a review or
  the owner's go-ahead in the conversation (Merging). A pull request does only what its
  description says. One pull request carries one change, so two unrelated changes are two pull
  requests.
- Status accounting. Record the status of each request and each change: not started, in
  progress or done. A status report names each one with its identifiers. List each open item
  with its reason and its next action: deferred work, a compiler proposal this repository still
  owes, a check that is not green.
- Verification and audit. Support a claim of completion with the checks that actually ran:
  the command or check, the date, the configuration (commit, pin, tool versions) and the
  result. Functional verification (`npm run check`, the extension in a host) and the document
  audit (`docs/`, the references and the skill match the pinned compiler) are separate. One
  does not replace the other. Report a check that did not run as not run.
- Deviations. Record each difference between the request and the delivered work on the pull
  request, with its disposition: closed, accepted by the owner, or open.

Each task runs in the order of a maintenance task card:

1. Identify the request, the configuration items it touches and their baselines.
2. Find the change record that authorizes the change, or open one.
3. Make the change inside what that record declares.
4. Verify the change with the functional checks and the document audit.
5. Record what was done, on which configuration, what was verified and what remains open.
6. Report the status of every request to the owner.

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
