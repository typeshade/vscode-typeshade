# TypeShade for coding agents: an MCP server, a skill and a Claude Code plugin

Status: **proposal**, with all three built and tested in the pull request that adds this file.
The pinned compiler is `typeshade/typeshade` at `ef049e4`, as in `docs/design.md`. Every claim
about the compiler names the file it comes from, and every claim about another tool names where
it was checked, because the tools this document compares move faster than the compiler does.

Related: `docs/design.md` (the editor: the tsserver plugin and the VS Code extension, whose
layering this document keeps) and the compiler's `docs/language-service-api.md` (the service all
of them adapt).

## 0. The question this answers

A coding agent editing a `"use typeshade"` file needs what a person in the editor has: the real
errors, the compiler's types, the generated code. It does not get them from the tools an agent
already has. An agent that reads diagnostics from a plain TypeScript language server sees what an
unhelped editor sees, which on the compiler's six examples is 58 errors, every one of them false
(`docs/design.md` §1.3). The obvious next question is whether a TypeScript language server
exposed over MCP already solves this. It does not, and the reasons decide the design.

### 0.1 What exists

Checked on 2026-09-23 by reading each project's source and, where marked, running it.

| Tool                                                                   | What it is                                                                                                                                                                   | TypeShade-aware?                                                        |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Claude Code's own `LSP` tool, fed by plugins such as `typescript-lsp`  | A built-in tool (definition, references, hover, symbols, call hierarchy) plus diagnostics pushed after each edit; `typescript-lsp` runs `typescript-language-server --stdio` | Only with the tsserver plugin loaded (§0.2)                             |
| [Serena](https://github.com/oraios/serena)                             | Symbol-level tools over language servers; installs its own TypeScript and `typescript-language-server`                                                                       | No: its initialization options are fixed                                |
| [lsmcp](https://github.com/mizchi/lsmcp)                               | LSP over MCP, TypeScript presets (`typescript-language-server`, `tsgo`)                                                                                                      | Possibly, through `initializationOptions` (read in the source, not run) |
| [cclsp](https://github.com/ktnyt/cclsp)                                | LSP over MCP for Claude Code                                                                                                                                                 | Possibly, through per-server `initializationOptions` (read, not run)    |
| [mcp-language-server](https://github.com/isaacphi/mcp-language-server) | A Go bridge from any LSP server to MCP                                                                                                                                       | No: its initialization options are fixed; dormant since mid 2025        |
| TypeScript 7 (`tsc --lsp --stdio`)                                     | The native compiler's own language server                                                                                                                                    | No: it has no plugin support at all, and no tsserver                    |

### 0.2 The plugin would make most of them TypeShade-aware

All of the bridges except TypeScript 7's end in tsserver, and tsserver loads plugins two ways:
the ones listed in a project's `tsconfig.json` under `compilerOptions.plugins`, and the ones
`typescript-language-server` passes with `--globalPlugins`, from its
`initializationOptions.plugins`. The second was run while writing this, with this repository's
built plugin, `typescript-language-server` 6.0.0 and TypeScript 5.6.3, over three of the server's
test shaders:

| Shader                               | Without the plugin                                                               | With it                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `clean.shade.ts`, nothing wrong      | 6 diagnostics, all false (`TS1206` on the decorators, `TS2304` on `f32`, `vec4`) | 0                                                              |
| `gradient.shade.ts`, nothing wrong   | 8, all false                                                                     | 0                                                              |
| `broken.shade.ts`, two real mistakes | 6: one real, five false                                                          | 4, the same four `check` reports, `typeshade(8004)` among them |
| hover on `vec4(...)`                 | `any`                                                                            | the constructor's signature and documentation                  |

So once `@typeshade/tsserver-plugin` is installable, one line in a project's `tsconfig.json` (or
the language server's own plugin list) gives every tsserver-based tool, Claude Code's `LSP` tool
among them, the answers `docs/design.md` §3 maps.

Three things keep that from being the whole answer today. The plugin is not on npm
(`docs/design.md` §7), so there is nothing to name. The TypeScript versions need care:
TypeScript 7 has no tsserver at all, and the compiler's own peer range stops before 6 (its
`package.json`), so the language server has to run the project's TypeScript 5, which
`typescript-language-server` 6 did here through its `tsserver.path` option although its README
now asks for TypeScript 6. And each agent wires a language server in its own way (a Claude Code
plugin's `lspServers`, Serena's configuration, lsmcp's), while one MCP server works in Claude
Code, Codex, Cursor, Gemini CLI and VS Code alike.

### 0.3 What no language server carries

The LSP-shaped half of the service is only half of what an agent needs. The rest has no LSP
request at all, which is the same finding `docs/design.md` §4 made about the preview panel:

- the emitted WGSL and GLSL, and whether an emitter refuses the module;
- the reflection: bind groups, uniform layouts with byte offsets, entry points;
- the determinism report;
- a run of one function on the CPU, with the compiler's own interpreter;
- the vocabulary, looked up by name rather than by position.

**Decision: an MCP server, as a third adapter over the same `TypeshadeLanguageService`, and the
tsserver plugin in `tsconfig.json` as the LSP route once the plugin is published.** The two are
not alternatives: the plugin gives an agent's LSP tool correct answers where one runs, and the
server gives every agent, in every client, the answers only TypeShade has.

## 1. Where it lives

In this repository, as `packages/mcp-server` (`@typeshade/mcp`), for three reasons. The
compiler's `docs/language-service-api.md` §1 puts the adapters here and keeps the service
editor-neutral. The server bundles the pinned compiler exactly as the plugin does, through the
same three specifier mappings (`tsconfig.base.json`, `scripts/build.mjs`,
`vitest.config.mts`), so a pin bump moves both at once. And it reuses the plugin's
`DocumentSync` (§3), which is the part of the plugin that took the longest to get right.

It adds no dependency to the compiler, which keeps the compiler's near-zero-dependency rule
(its `AGENTS.md`) intact: the MCP SDK and zod are bundled into the server, not into anything
the compiler ships.

## 2. The tools

| Tool         | Answer                                                                                     | Source                                                            |
| ------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `check`      | Diagnostics for a file, several, every shader under a directory, or source text            | `getDiagnostics`, then `compile()`'s `BACKEND` diagnostics (§3.1) |
| `compile`    | WGSL, GLSL ES 3.00 (both stages), reflection, determinism report                           | `compile()`, `reflect()`                                          |
| `hover`      | The compiler's type and the documentation                                                  | `getHover`                                                        |
| `definition` | Where a name is declared, or that it is part of the language                               | `getDefinition`, then the vocabulary                              |
| `references` | Every use across the workspace's shaders                                                   | `getReferences`, over every shader under the roots                |
| `outline`    | Structs, resources with their slots, functions, entries, each with its type                | `getDocumentSymbols`, with `getHover` for each type               |
| `docs`       | A name's sentence and every overload; a GLSL or HLSL name translated; the whole vocabulary | `TYPE_DOCS` and the five other tables, `SHADE_DTS`                |
| `run`        | One function's result at f32 or f64, with breakpoint stops that list every local           | `typeshade/debug` (§3.4)                                          |

Three conventions hold for every tool, and each is there for the model reading the answer.

- **Positions are one-based, and a symbol can stand in for a column.** A model reads line numbers
  off a file viewer that numbers from one, and it names an identifier far more reliably than it
  counts columns, so `{ "line": 13, "symbol": "tint" }` is the usual shape. A symbol that is not
  on the line is an error that quotes the line, so the next attempt can be right.
- **Answers are text shaped like compiler output.** `error TS8004 [typeshade] a.shade.ts:5:13`, the
  message, the line with a caret under the span. The source is printed beside the code because
  TypeShade's codes overlap TypeScript's from 8001 to 8039 (`docs/design.md` §3).
- **A mistake the agent made is a tool result, not a protocol error.** A path outside the
  workspace, a missing function, arguments of the wrong shape: each comes back with `isError`
  and a sentence, because clients show protocol errors to the person and tool results to the
  model, and only the model can fix the call. Anything else that throws is labelled as the
  server's own fault, so a model does not rewrite a correct shader to work around it.

Every tool is annotated read-only; nothing in the server writes a file.

## 3. Decisions inside the server

### 3.1 Diagnostics: the editor's, plus what only the emitters see

`check` returns what the plugin shows: the service's merged list, TypeScript's findings with the
false positives filtered (`TS_DIAGNOSTIC_FILTERS`, compiler `src/language-service/diagnostics.ts`)
and the front end's own. The service analyses with `emit: false` (compiler
`src/language-service/service.ts`), so it never meets an emitter that refuses a module the front
end accepted: a non-struct `uniform<vec4>` is valid TypeShade that the GLSL ES 3.00 emitter
refuses, as a `BACKEND` (`TS8015`) warning. So when the service reports no error, `check` also
runs `compile()` and adds its `TS8015` entries. "No problems" then means what an agent assumes
it means: the file emits.

### 3.2 Files come from the disk, through the plugin's own sync

The plugin's `DocumentSync` keeps the TypeShade program in step with tsserver's snapshots, and
its three rules (`docs/design.md` §1.1) are exactly what a long-lived server needs too. The one
that matters most is the third: the service's host caches a shader it reached through an import
and never re-reads it, so an agent that edits `lib.shade.ts` would otherwise get stale answers
about `main.shade.ts`. The server feeds the same class from the disk instead of from snapshots: a
script version is a hash of the file's current text, read at most once per request. The test
`sees an edit to an imported shader from the file that imports it` pins it.

One service lives as long as the server, because the ambient lib is most of the cost of a
program (`docs/design.md` §1.3) and a long-lived service parses it once.

### 3.3 Which files it may read

The arguments are text a model wrote, possibly after reading text someone else wrote. So every
path resolves against the first root, is canonicalized with symbolic links followed, and is
refused unless it lands inside a root; the reader the service calls for an import applies the
same rule. The roots are the directories given with `--root`; else the workspace folders the
client reports through MCP roots, asked for once the handshake completes and again when the
client says they changed; else the directory the client started the server in. Roots come before
the working directory because not every client starts a stdio server in the project, and a
client that answers `roots/list` has said where the project is.

### 3.4 Running a function: the debugger's engine, with a step budget

`run` uses `typeshade/debug`, the engine `docs/design.md` §5 gives the debug adapter, so a
result is the compiler's own reference, at f32 by default because that is what a GPU computes
(`docs/debugging.md` §5 decision 6 in the compiler). It does not use the adapter's one call,
`startDebugSessionFromConfig`, because that call takes no step budget, and an unattended server
must not be hung by a loop that does not end. It calls the two public resolvers that call is
built from, `resolveInvocation` and `resolveBindings`, then `startDebugSession` with `maxSteps`
of two million statements. The compiler bounds every loop at 256 trips, so a real shader stays
far below that; a shader written to reach it (three nested loops of 256) takes about three
seconds and ends with the engine's own sentence. Asking the compiler to accept `maxSteps` in the
launch configuration would let the server return to the one call (§8, item 2).

GPU-only intrinsics (derivatives, texture reads) have no CPU value, and the engine refuses them
unless stand-ins are asked for. The server keeps the engine's default and its reason, "a
plausible wrong number is the worst failure mode for a reference": `gpuStubs` is opt-in, and a
run that used a stand-in says which.

A helper takes positional arguments, checked against its parameters before anything runs, so a
`vec3` passed for a `vec2` is a sentence rather than a `NaN` in the result. An entry point takes
its inputs keyed by `@builtin` id, which is the launch configuration's own shape.

### 3.5 The vocabulary is the compiler's, and a foreign name is translated

`docs` reads the six documentation tables the service's hover and completions read, and the
signatures out of `SHADE_DTS`, so it cannot disagree with the editor and needs no change when a
builtin is added. What it adds is for the way models write shaders: they reach first for the
names they have read most, which are GLSL's and HLSL's. `FOREIGN_NAMES` maps 112 of
those to TypeShade's (`lerp` to `mix`, `gl_FragCoord` to `@builtin("position")`, `fmod` to the
`%` operator), and a test holds it to two rules: every target is a name the tables have, and no
source is one, since the tables are asked first and such an entry could never be reached.
Anything else gets the nearest names by edit distance.

### 3.6 The SDK, and what the bundle carries

`@modelcontextprotocol/server` 2.0.0: the v2 line has been the stable one since 2026-07-27 and
v1 is in maintenance. It is bundled with zod, so the package's only dependency is `typescript`,
external for the reason the plugin's is: one copy, the one npm installs beside it. The bundle is
2028 KB. Its handshake reports the compiler it carries, as the vendored `package.json` version
and the submodule's commit, because a model told which language it is talking to can tell a
language change from its own mistake.

## 4. The skill

`plugins/typeshade/skills/typeshade/SKILL.md` teaches the language to an agent in the
[Agent Skills](https://agentskills.io) format, which Claude Code, Codex, Cursor and Gemini CLI
all read. It uses only the portable fields (`name`, `description`), so the directory can be
copied into any of them as it is.

It is short where the compiler's documentation is long, and it spends its words on what an agent
gets wrong: the GLSL or HLSL name for a builtin, a string passed to `console.log`, a loop bound
over 256, a missing return annotation, the integer literal rule. It says to run `check` after
every edit and how to use the other tools, and it keeps working without the server.

**Every `"use typeshade"` block in the skill compiles.** `skill.test.ts` extracts each one and
compiles it against the pinned compiler, the way the compiler's own
`src/compiler/ts/doc-snippets.test.ts` holds its documentation; a block meant to fail names its
expected code and must produce exactly that. So the pull request that moves the pin fails when
the language moves under the skill, which is the moment to rewrite it.

The same suite holds the skill's two tables to their sources: the GLSL and HLSL names in
`SKILL.md` must translate exactly as the server's `docs` tool translates them, and
`references/diagnostics.md` must list every code in the compiler's `src/compiler/ts/codes.ts`,
by the name it has there. Its first run caught one mistake already: an example local named
`smooth`, which WGSL reserves (`TS8068`).

One formatting rule follows from that. Prettier formats the TypeScript inside Markdown code
blocks, and TypeShade is not TypeScript to a formatter: it rewrote `"use typeshade"` as
`'use typeshade';` and `vec3(0.)` as `vec3(0)`, which turns a float into an integer-written
literal. So `.prettierrc.json` turns embedded formatting off for the skill's Markdown, and the
suite fails on a shader block whose directive has been rewritten, instead of skipping it.

## 5. The Claude Code plugin

`.claude-plugin/marketplace.json` makes this repository a marketplace with one plugin,
`plugins/typeshade`, which carries the skill and the server:

```text
/plugin marketplace add typeshade/vscode-typeshade
/plugin install typeshade@typeshade
```

Both manifests and the skill pass `claude plugin validate` (Claude Code 2.1.280), and the
plugin installs from a local checkout of the marketplace: `claude plugin details` counts one
skill and one MCP server, about 230 tokens loaded into every session and about 5,000 when the
skill is used. The skill works as soon as the plugin is installed. The server entry
(`plugins/typeshade/.mcp.json`) runs `npx -y @typeshade/mcp`, so it starts working the day that
package is on npm (§6); `claude mcp list` reports it as failing to connect until then, and
reports a local build registered with `claude mcp add` (`packages/mcp-server/README.md`) as
connected.

**No language server in the plugin, yet.** A plugin can declare one (`lspServers`), and §0.2
shows what it would run. It waits for three things: `@typeshade/tsserver-plugin` on npm, so there
is a package to load; the TypeScript version question of §0.2; and a way to live beside the
official `typescript-lsp` plugin, since both would claim `.ts` files. Until then, a project that
installs the tsserver plugin itself can name it in `compilerOptions.plugins` and get the same
effect in every tsserver-based tool, with no plugin change at all.

## 6. Publishing

`@typeshade/mcp` is marked private, like the other two packages, and publishing it is the
owner's decision, with the same shape `docs/design.md` §7 gives the tsserver plugin: npm trusted
publishing (or an `NPM_ACCESS_TOKEN`), provenance, a release tag equal to the version, and the
root `LICENSE` copied beside the manifest before `npm publish`. Unlike the plugin, it does not
have to wait for the compiler to publish: the bundle carries the compiler, so its one dependency
is `typescript`, which is on npm.

## 7. Measured

On this container, through the built bundle and a raw stdio client, three runs:

| What                                      | Time          |
| ----------------------------------------- | ------------- |
| Start to the end of the handshake         | 496 to 567 ms |
| First `check` (builds the program)        | 233 to 258 ms |
| The same `check` again                    | 8 to 14 ms    |
| `check` of a second file                  | 22 to 26 ms   |
| `hover`                                   | 12 to 15 ms   |
| `compile` to WGSL and GLSL                | 8 to 9 ms     |
| `run` of a fragment entry                 | 11 to 17 ms   |
| First `docs` (parses the ambient lib)     | 49 to 62 ms   |
| `run` that reaches the two-million budget | about 2.9 s   |

## 8. Open questions

Each with the answer this document would take.

1. **Publish `@typeshade/mcp` before the compiler's 0.1.0?** _Suggested: yes._ It bundles the
   compiler and depends on nothing unpublished, and the plugin's server entry is inert until it
   exists.
2. **Should `startDebugSessionFromConfig` take `maxSteps`?** _Suggested: yes, as an issue on the
   compiler._ The server could then make the adapter's one call (§3.4).
3. **A call across two shader files reports `TS8004` at this pin**, from the service and from
   `compile()` alike: both analyse one file, and the compiler's multi-file form,
   `compileTsSources`, is not on its public surface (`src/__api__/surface.md` does not list it).
   _Suggested: report what they report._ The server is an adapter, and the fix belongs to the
   compiler.
4. **A hook that checks every edited shader without being asked?** A plugin can run a command
   after each `Edit` or `Write`. _Suggested: after the package is on npm, and only if the skill's
   instruction to call `check` turns out not to be followed._ A hook that starts `npx` on every
   edit costs a process per keystroke-sized change.
5. **The language server in the plugin** (§5). _Suggested: when `@typeshade/tsserver-plugin` is
   published, as a separate plugin, so a user of the official `typescript-lsp` plugin can choose._

Last updated: 2026-09-23
