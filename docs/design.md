# TypeShade in the editor: architecture and decisions

Status: **proposal** for review. The pinned compiler is `typeshade/typeshade` at `eb0dde6`
(2026-09-23). The document was first written against `3c0a2d7`, then against `a2240e0` (#51, 2026-09-15) plus three
branches that had not merged then and have since: `claude/d1-debugging-design` (PR #28, the
debugging design), `claude/d1-stepping-oracle` (PR #35, the `./debug` subpath) and
`claude/d1-launch-config` (PR #41, the launch configuration and the value formatter). The move
from `a2240e0` to `ef049e4` renames the package from `@xgis/shader-dsl` to `typeshade`, adds the
`./debug` and `./shade` subpaths, and grows `./language-service` by three exports
(`FUNCTION_DOCS`, `CONSTANT_DOCS`, `MATH_MEMBER_DOCS`) and nothing the plugin maps, so every
mapping in §3 stands as written. The move from `ef049e4` to `eb0dde6` removes nothing this
repository names and changes no mapping; the figures below that name `ef049e4` were measured
there. Every claim about the compiler names the file it comes from.
Nothing here is frozen, and §8 lists what is still open with the answer this document would
take.

Related: the compiler's `docs/language-service-api.md` (the language service contract, whose §1
and §10 item 8 place the language server and this repository's work), its `docs/debugging.md`
(the debugger's design, whose §5 decision 8 places the debug adapter here), and its
`docs/use-typeshade-surface.md` (the language).

## 0. What exists, on both sides

On the compiler side, the language service is built and tested. `createTypeshadeLanguageService`
(`src/language-service/service.ts`) owns one `ts.LanguageService` over its own in-memory
document store (`src/language-service/host.ts`) and answers sixteen methods: document
lifecycle, diagnostics, completions, hover, definition, references, document symbols, signature
help, prepare-rename and rename, semantic tokens, compiled output, and the two position
conversions. It is exported as the package subpath `./language-service`
(`package.json` `exports`), it never imports a DOM or Node API, and it holds one cached
front-end analysis per document that diagnostics, symbols, tokens, hover and compiled output
all read. The cache key is `dependencyKey(uri)` (`src/language-service/service.ts`), the
document's own script version followed by the version of every document it imports,
transitively, so an edit to an imported shader invalidates the importer without the importer
being touched (`docs/language-service-api.md` §8).

Four properties of that service decide almost everything below.

1. **It builds its own program, with its own options.** `typeshadeCompilerOptions()` in
   `src/language-service/host.ts` is `lib: []`, `types: []`, `strict: true`,
   `experimentalDecorators: true`, `strictPropertyInitialization: false`, and the ambient
   vocabulary arrives as one virtual file under the uri `typeshade:shade.d.ts`
   (`AMBIENT_LIB_URI`), whose text is the `SHADE_DTS` string from
   `src/language-service/ambient.ts`.
2. **`lib: []` is required, not preferred.** `SHADE_DTS` declares its own `Array`, `Function`,
   `Object`, `Math` and `Pick` stand-ins, because a `"use typeshade"` file is not a JavaScript
   program. Dropped into a program that also loads the standard library it collides head-on: 19
   errors on `hello.shade.ts`, most of them reported inside `lib.es5.d.ts` and `lib.dom.d.ts`
   (duplicate `Pick`, `Math` redeclared, duplicate index signature for `number`), measured on
   `claude/c6-ambient-lib` and written up in that branch's README section "Type-checking
   `.shade.ts` with tsc".
3. **It knows types TypeScript cannot.** Since #51 the front end records every name a document
   declares, with its `ShaderType` and the span of the declared identifier
   (`src/compiler/ts/symbols.ts`, reaching the service as `CompileTsSourceResult.symbols`), and
   `getHover` renders the compiler's type for those names. That closes a gap the ambient lib
   cannot: the scalar brands are optional, so TypeScript infers `let x = 1.` as plain `number`
   where the compiler means `f32`. It is also why §3 replaces quick info rather than merging it,
   and the probe measured what the unhelped answer looks like, `vec4(...)` reading as `any`.
4. **The service decides which TypeScript diagnostics survive.** The filter table is
   `TS_DIAGNOSTIC_FILTERS` in `src/language-service/diagnostics.ts` (lines 760 to 839), seven
   rules each carrying its own reason: TS1206 under `isDecoratorOnTopLevelFunction`, which
   covers the stage decorator on the function and `@builtin(...)` and `@location(...)` on its
   parameters alike; TS2362, TS2363, TS2365 and TS2322 under four predicates that ask the
   checker whether the operand's own type carries one of `GPU_BRAND_TAGS` (`ambient.ts`); and
   TS2345 and TS2769, the same arithmetic reaching a call's argument, the second for an
   overloaded callee, dropped only when the shape the arithmetic would have produced is one
   some overload accepts. `docs/language-service-api.md` §6 is the policy behind them, and it
   names TS2304, TS2349, TS2564 and TS1206 in prose; the arithmetic rules live only in the
   source file, which is why this document cites the file. `tsc` on its own cannot do any of that filtering: the
   `claude/c6-ambient-lib` branch measured 11 TS1206 left over across the five examples.

On this repository's side there is the workspace of PR 0 and nothing else: a pass-through
plugin skeleton, an extension skeleton, and the gate.

Between the two sits the fact this whole document is about. A TypeShade file needs the program
of point 1, and the editor already has a different one.

## 1. Delivery vehicle

**Decision: a TypeScript server plugin is the core, and the VS Code extension is a thin shell
over it plus the pieces tsserver cannot carry.**

### 1.1 The shape

`@typeshade/tsserver-plugin` is a CommonJS module whose module export is the factory tsserver
calls (`ts.server.PluginModule` and `ts.server.PluginCreateInfo` are declared in
`typescript/lib/typescript.d.ts`, not only in the deprecated `tsserverlibrary.d.ts`). tsserver
hands it the project's `LanguageService`, the project's `LanguageServiceHost`, and its own
`typescript` module; the factory returns a service that is the project's own for every file and
TypeShade's for a file carrying the directive.

Inside, the plugin owns one `TypeshadeLanguageService` per project. Documents are synced from
tsserver's own script snapshots, so the plugin never reads a file itself: on each request for a
file it wants to answer for, it compares `info.languageServiceHost.getScriptVersion(fileName)`
with the version it last stored and calls `openDocument` or `updateDocument` with
`getScriptSnapshot(fileName).getText(0, length)` when they differ.

Three rules keep that document set honest, and each exists because of something in the
service's own host (`src/language-service/host.ts`).

- **A file that loses its directive is closed.** Editing `"use typeshade"` out of a file makes
  it an ordinary TypeScript file, and from the next request the plugin passes it through; if
  the plugin did not also call `closeDocument`, the TypeShade program would hold it forever,
  since the file is still in the project and the pruning rule below cannot fire for it. A file
  that gains the directive is the same transition backwards, and costs nothing: the next
  request syncs it like any other.
- **A file the project drops is closed.** The plugin compares
  `info.project.getProjectVersion()` and prunes documents no longer in the project's file
  names, which is the only other moment the set can shrink.
- **An imported shader is opened as a document, not left to `readDocument`.** The host caches a
  file pulled in through `readDocument` in its `imported` map on first resolution
  (`host.ts`, `resolveModuleNameLiterals`) and never re-reads it while it stays there, so its
  script version is frozen at the revision of that first read and an edit to it would be
  invisible to the importer's diagnostics. The plugin therefore syncs every directive-carrying
  file it resolves an import to, by the same version comparison as above, and `readDocument`
  stays as the fallback for a file tsserver has no snapshot for.

Every editor that runs tsserver gets the result: VS Code, Cursor, Windsurf, WebStorm, Neovim's
`ts_ls`, Sublime's LSP-typescript. The VS Code extension's part in it is four lines of manifest,
`contributes.typescriptServerPlugins` (§4).

### 1.2 What the alternative would cost

A standalone LSP server is the shape `docs/language-service-api.md` §1 and §10 item 8 name, and
it is a real option: the service is already LSP-shaped, so the server would be document sync,
JSON-RPC, semantic token delta encoding, and nothing else. What it does not solve is the part
that matters:

- **It cannot make TypeScript's own answers go away.** A `.shade.ts` file is a `.ts` file, so
  VS Code's built-in TypeScript extension claims it and publishes diagnostics for it. Measured:
  58 false semantic errors across the compiler's six examples
  (`docs/measurements/two-program-cost/`), and 4 on a nine-line fragment through a real tsserver
  (`docs/measurements/tsserver-plugin-load/`). A separate server publishes its own diagnostics
  beside those, so the user sees both sets. The only supported way to suppress the built-in
  extension's semantic answers for a file is to stop the file being TypeScript, which means a
  separate language id, which throws away TypeScript's own grammar, its rename, and every other
  extension that works on TypeScript. A plugin replaces the answers instead of competing with
  them.
- **It buys nothing the plugin does not have.** Both run the same
  `TypeshadeLanguageService`. The difference is the transport and who owns the buffer.
- **It costs a second editor integration per editor.** The plugin is configuration; a language
  server is a client per editor.

The plugin's own cost is the honest half: a plugin runs inside tsserver, so a slow or throwing
plugin degrades the editor's TypeScript experience for the whole project, and plugin loading is
opaque when it fails. §6 answers the first with a per-request budget and a pass-through on
exception, and the second with the log assertion the probe already makes.

An LSP server stays additive. It would be a second adapter over the same service, for editors
with no tsserver, and nothing in this design forecloses it. That is §8 item 4.

### 1.3 What the two programs cost

The measurement, its driver and its harness are in `docs/measurements/two-program-cost/`. It
runs under node, because tsserver does, in a process that does nothing else, three times per
mode, over a fixture of 150 plain TypeScript modules plus the compiler's six `.shade.ts`
examples. The plugin's code is measured as it will ship: an esbuild CommonJS bundle of the
compiler's `./language-service` subpath, 470 KB (481,235 bytes), with `typescript` external.

That 470 KB is the language service alone, which is what the measurement is about. The plugin's
own bundle, the same subpath plus everything in `packages/tsserver-plugin/src`, was 498 KB
(509,564 bytes) when built at that pin. The two numbers are close enough to be mistaken for each
other and they measure different things, so both are spelled out wherever either appears. Every
figure in this section was measured with the compiler at `a2240e0`; at `ef049e4` the same
subpath bundles to 1111 KB (1,137,449 bytes) and the plugin to 1138 KB (1,165,707 bytes), and
one re-run of the six-shader fixture there gave 83.2 to 111.1 ms and 18.6 MB to require the
bundle, 169.5 to 219.5 ms and 8.6 MB to build and answer, 27.2 MB retained, and 5.9 to 7.5 ms
per keystroke against the project program's 11.1 to 13.1 ms, with the same 58 false errors
without the plugin and none with it.

The phases are separated because they are paid at different times.

| What                                                          | When it is paid           | 6 shaders                 | 60 shaders                |
| ------------------------------------------------------------- | ------------------------- | ------------------------- | ------------------------- |
| Requiring the plugin's bundle                                 | once per tsserver process | 78.9 to 90.5 ms, 11.8 MB  | 76.0 to 83.7 ms, 11.8 MB  |
| Building the TypeShade program and answering for every shader | once per project          | 119.7 to 129.7 ms, 5.1 MB | 234.9 to 264.8 ms, 8.0 MB |
| Retained in tsserver, both phases together                    |                           | 16.9 MB                   | 19.8 MB                   |
| One edit plus diagnostics for a shader file                   | once per keystroke        | 5.9 to 6.2 ms             | 5.6 to 5.7 ms             |

Beside them, what the editor does today with no plugin, on the same fixture: 1048.7 to
1088.5 ms to build the project and answer for all 156 files, 63.8 MB of heap for that program,
14.7 to 15.6 ms for one edit to a shader file, and **58 semantic errors on the six examples,
every one of them false**, exactly 58 in every run.

So the plugin adds about 17 MB and about 200 ms, once, to a process that is already holding
63.8 MB for the project itself, and answers a keystroke in a shader file faster than the
project program does. The keystroke figure looks like a mistake and is not: the TypeShade
program re-checks one small file against the ambient lib alone, while the project program
re-checks the same file against `lib.es2022` plus `lib.dom` inside a 156-file program.
`SHADE_DTS` was 11015 characters over 265 lines at `a2240e0`, and is 164,240 characters over
2636 lines at `ef049e4` (both measured through the subpath), ten times larger and still under a
tenth of the 32,672 lines of `lib.es5.d.ts` and `lib.dom.d.ts` alone, which is why the
re-measured keystroke above kept its lead.

**Where the cost lives, and what it scales on.** The fixed half is the larger one: loading the
plugin's own code costs 11.8 MB whatever the project holds, flat between the two fixtures. The
per-project half scales on shader files alone, and gently: ten times the shaders costs 2.9 MB
more and roughly twice the time, while the 150 host modules contribute nothing to either, since
a TypeShade program holds the shader files and `SHADE_DTS` and nothing else (§1.7 is why that
is a language fact rather than a configuration choice). The fixture's host count was not varied,
so "a larger project costs the second program nothing" is an argument from what is in the
program, not a measurement of two project sizes.

**The method is part of the finding.** An earlier version of this section reported 63.3 ms and
4.4 MB, and neither reproduced: measured in one process that also held the project program, the
same heap quantity came back as 5.1, 13.1 and 40.3 MB on three runs. Measured in isolation it
is 5.1 MB in every run, to the tenth. The README records the four method faults and the fifth
found during the rewrite, that charging the plugin for loading `typescript` (which tsserver has
loaded before it asks for a plugin) tripled the require phase. An independent run of the
corrected method, in this pull request's review, reproduced the heap figures to 0.1 MB.

### 1.4 How a TypeShade file is recognized

**Decision: by the directive, read off the parsed source file, never by the file name.**

The rule is the compiler's own: `hasUseTypeshadeDirective(sourceFile)`, exported from the
package root (`src/index.ts`, from `src/compiler/ts/directive.js`), which returns true when any
top-level statement is an `ExpressionStatement` whose expression is a string literal with the
exact text `use typeshade` (`src/compiler/ts/directive.ts`). Using the compiler's exported
predicate rather than a copy is what keeps the editor's answer and the compiler's answer the
same when the rule changes.

`.shade.ts` is a convention, and a useful one: it is what the Vite plugin matches and what the
examples are named. It is not the rule, because the compiler's rule is the directive, and an
editor that disagreed with the compiler about which files are shaders would be worse than an
editor with no support at all. The extension is free to use the name where the name is all it
has, which is exactly one place: a glob for an activation event (§4).

The cost of reading the directive is a parse, and the plugin pays nothing for it: the source
file it reads is the one tsserver's own program already parsed, taken from
`info.languageService.getProgram()`. A file that is not a shader costs one `statements` scan of
its top level and no more.

### 1.5 What the plugin does for a file without the directive

Nothing at all. Every decorated method checks the directive first and, when it is absent, calls
straight through to the project's own method and returns its result unchanged. There is no
mapping layer in that path, so there is nothing to have a bug in. §6 pins it with a test that
compares a whole protocol session's events with the plugin loaded against the same session with
the plugin absent and requires them to be identical for non-directive files.

### 1.6 A `.ts` file that imports a `.shade.ts` file

**Decision: the host side stays plain TypeScript, answered by tsserver's own program, and the
plugin does not touch it.**

A host module that does `import { fs } from './shader.shade.js'` is asking a question about
values and types in its own program, not about shader semantics. tsserver already answers it:
the shader file is in the project, so its exported entry functions have types there, computed
against the standard library rather than against `SHADE_DTS`. Those types are approximate
(`vec4` is unresolved in that program, so an entry's return type degrades to an error type), but
they are approximate in the file the user is not editing as a shader, and the alternative is
strictly worse: for the plugin to answer a host file's question about an imported shader, it
would have to hold host files in the TypeShade program, which is the collision of §0 point 2.

What the user sees, then, is that a host file importing a shader has the TypeShade file's errors
attributed to the TypeShade file (where the plugin replaces them) and the import itself resolved
normally. The one visible rough edge is hover on an imported entry inside a host file, which
reads as TypeScript sees it. §8 item 5 keeps a better answer open now that the compiler ships
`shade.d.ts` as a real file (the `./shade` types-only subpath, `"./shade": "./dist/shade.d.ts"`
in `package.json` at the pin, written by `scripts/emit-shade-dts.ts` at build time), because a
host project can then put its shader sources in a separate `tsconfig` and the question stops
being about one program.

### 1.7 A `.shade.ts` file that imports a plain `.ts` file

**Decision: the plugin serves the TypeShade program only files that carry the directive. A
relative import of a non-directive file resolves to nothing, and TypeScript reports it from the
shader file as an unresolved module.**

The reason is §0 point 2 again: a plain TypeScript module is written for the standard library,
and the TypeShade program has none. Pulling it in would put its own text under `lib: []` and
produce errors inside a file the user never asked to be a shader. The compiler's own multi-file
story is a story about shaders only: `compileTsSources` now has one form
(`src/compiler/ts/module.ts`), taking a list of `{ fileName, source }`, and since #74 it merges
every file's structs, bindings and overrides into one module, while naming a struct in an
import is still open (`docs/language-service-api.md` §11). A plain module has no place in it,
so the editor is not the place to invent one.

Concretely, the plugin's `readDocument` host hook (`TypeshadeLanguageServiceHost.readDocument`,
`src/language-service/host.ts`) reads the file through tsserver's host, parses its first
statements for the directive, and returns the text only when the directive is there. The
resulting message ("Cannot find module './util.js'") is honest but unhelpful, and improving it
needs a diagnostic the compiler owns rather than one the adapter invents, which is §8 item 3.

### 1.8 The editor goes green while `tsc` stays red

This is the most visible cost of the decision, and it will be the first bug report.

The plugin replaces the language service's answers, and nothing else. A project whose
`tsconfig.json` includes its `.shade.ts` files keeps compiling them as ordinary TypeScript, so
`tsc --noEmit` on the command line and in CI keeps reporting the same errors §1.3 measured, 58
of them across the six examples, while the editor shows a clean file. An editor and a build
that disagree about whether the code compiles is worse than either being wrong on its own.

The remedy exists and is measured, on `claude/c6-ambient-lib`: the shader sources go in a
project of their own, a `tsconfig.shade.json` with `lib: []`, `types: ["typeshade/shade"]`,
`experimentalDecorators` and `strictPropertyInitialization: false`, which leaves 11 TS1206 and
one TS2542 across the five examples there (the TS2542 is fixed on `main`, since the ambient
`array<T, N>` index signature is writable now). `lib: []` is not a preference in that file
either, for §0 point 2's reason.

**Decision: the extension notices and offers, and never edits a `tsconfig.json` on its own.**
Concretely: when a directive file is open and the workspace has a `tsconfig.json` whose
`include` reaches it, the status bar item (§4) says so, and a command,
`typeshade.createShaderTsconfig`, writes `tsconfig.shade.json` beside it and prints the one
line the user must add to the main config's `exclude`. Writing into an existing `tsconfig.json`
unasked is the kind of help that loses trust the first time it reformats a file.

The residual TS1206 is not something this repository can close: it is a grammar rule, and only
the language service filters it (§0 point 4). A project that wants a silent `tsc` filters that
code in its own build. That is §8 item 9.

## 2. The compiler dependency before 0.1.0

The compiler is not on npm. Its `package.json` `exports` point at TypeScript sources
(`"." : "./src/index.ts"`), its name is `typeshade` (it was `@xgis/shader-dsl` until #29, which
also brought the `dist/` layout and the publish workflow), and one entry already points at
`dist/`: `"./shade": "./dist/shade.d.ts"`, the ambient lib as a types-only subpath. Every other
checked-in export stays on `./src/*.ts`: `scripts/publish-manifest.ts` rewrites them onto
`dist/` at publish time, in a checkout that is thrown away. That is what makes "the compiler's exports pointing at `.ts` costs us
nothing" true, before and after it publishes.

**Decision: a pinned git submodule at `vendor/typeshade`, bundled from sources with esbuild,
replaced by the npm dependency `typeshade` on the day it publishes.**

This is what the site does with `vendor/shader-dsl`, and it has three properties nothing else
here has. The pin is a commit, so a bisect is possible and a bump is a reviewable diff of one
line. The sources are compiled by our own build, so the compiler's `exports` pointing at `.ts`
costs nothing. And the switch to npm is a one-line change of an import specifier's resolution,
because the bundle is built against the same specifiers the published package will serve
(`typeshade` and `typeshade/language-service`, never a deep path into `src/`).

How it is wired:

- `vendor/typeshade` is a submodule pinned to a commit of `typeshade/typeshade`. CI checks out
  with `submodules: true`.
- `packages/tsserver-plugin` and `packages/vscode-typeshade` import three package specifiers:
  `typeshade`, `typeshade/language-service`, and, once PR 4 needs it, `typeshade/debug`. The
  workspace root maps them to `vendor/typeshade` through `tsconfig` `paths` for type-checking
  and through an esbuild alias for the bundle, in one place each, so the eventual npm
  dependency deletes three entries and changes no source file. All three are in the pinned
  `exports` (`"./debug": "./src/debug.ts"` since #35), so the switch to npm waits on nothing but
  the compiler publishing.
- **The two bundles are not configured alike, and the difference is load-bearing.** The plugin
  bundle marks `typescript` external, because tsserver hands the plugin its own instance
  (`modules.typescript`, §1.1 and §3) and a second copy would build nodes a different `ts`
  cannot recognise. The extension bundle **inlines** `typescript`, because the VS Code
  extension host injects only `vscode` and resolves everything else from what the `.vsix`
  ships, and §4's preview panel runs a `TypeshadeLanguageService` of its own, whose first
  `require('typescript')` would otherwise throw at runtime in a packaged extension while
  working perfectly in the development host, where `node_modules` is on disk. Inlining is the
  choice rather than planting a real `node_modules/typescript` in the `.vsix` because esbuild
  drops what the language service does not reach, and one artifact is easier to reason about
  than a directory the packaging step has to keep in sync. §7 carries the weight it adds.
- Both bundles are esbuild with `platform: 'node'`, `format: 'cjs'`, `target: 'node20'`, and
  `vscode` external in the extension's, because the extension host provides it.
- One measured fact that a reader will otherwise lose a day to: the vendored checkout must
  resolve the workspace's own `typescript`. With the checkout outside the workspace, `typescript`
  resolved to a global 7.0.2 install in this container, and the compiler's sources then failed at
  module evaluation with `ts.SyntaxKind` undefined. Inside `vendor/`, node's upward resolution
  finds the workspace's pinned 5.6.3 and the same import works. That is the reason the submodule
  path is inside the repository rather than a sibling checkout.

**How the pin is bumped.** A bump is its own pull request, and it carries: the submodule commit
moved to a specific SHA of `typeshade/typeshade` `main` (never a branch), the compiler's
`src/__api__/surface.md` diff between the old and the new SHA quoted in the body (that file is a
generated list of every public export, and `git diff` over two SHAs of it is exactly the list of
what changed for us, which is what the compiler's own `src/api-surface.test.ts` exists to
guarantee), and the full local gate green. A bump that changes what the plugin maps also changes
§3's table in the same pull request. Nothing else may move the pin: no floating branch, and
nothing in CI that moves the pin on `main` (no `--remote` update in a build, no auto-merge).

**Who proposes the bump.** A workflow does, so the pin stops falling behind: by hand it had
drifted 104 commits by #4. `.github/workflows/pin-compiler.yml` runs once a day, on demand, and
on a `compiler-updated` repository dispatch. It resolves the compiler's `main` to one SHA,
commits the submodule at that SHA on the `pin/compiler` branch, and opens one pull request (or
refreshes the one already open) whose body lists the compiler commits it takes in and quotes the
`surface.md` diff between `main`'s pin and the new SHA. A diff over 200 lines is summarised
instead of quoted, by `scripts/surface-diff.mjs`: the export count per subpath, and every export
and every shape definition added, removed or changed. That keeps the decision above intact, not
relaxed. The workflow proposes a specific SHA and never a branch, it never merges, and a person
reads the surface diff, fixes on the branch whatever the new compiler breaks, updates §3's table
if the mapping moved, and merges it. A run that finds the pull request open pushes on top of it
and never force-pushes over the fixes on it. A pull request opened with `GITHUB_TOKEN` starts no
`pull_request` run, so the workflow dispatches `ci.yml` on the branch, which is why `ci.yml`
takes `workflow_dispatch`; `ci.yml` only checks and publishes nothing from any ref. The
repository needs one setting for the pull request step: Settings > Actions > General > "Allow
GitHub Actions to create and approve pull requests". Without it the branch is pushed and the
pull request step fails, so the proposal is never silent.

## 3. The feature matrix

The compiler's own layering rule (`docs/language-service-api.md` §1) is that adapters convert
and the service decides. The plugin is an adapter, so this table is a mapping table and every
row's right column is a call into `TypeshadeLanguageService`.

Two general rules apply to every row. For a file without the directive, the plugin calls the
project's method and returns its result unchanged (§1.5). For a file with the directive, the
plugin answers from the TypeShade service and never merges the two, because merging is how a
false positive survives.

Which methods matter was read off `typescript.js` rather than off the type declarations: every
`getLanguageService().<method>` and `languageService.<method>` call site in the pinned 5.6.3 was
listed, so a row here names something tsserver actually calls.

| `ts.LanguageService` method                                                             | Directive file                                                        | Service call                        |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------- |
| `getSemanticDiagnostics`                                                                | replaced, minus the entries the syntactic pass already reported       | `getDiagnostics(uri)`               |
| `getRegionSemanticDiagnostics`                                                          | replaced with nothing (below)                                         | none                                |
| `getSyntacticDiagnostics`                                                               | passed through                                                        | none                                |
| `getSuggestionDiagnostics`                                                              | replaced with nothing                                                 | none                                |
| `getQuickInfoAtPosition`                                                                | replaced, so the compiler's own type reaches the tooltip (§0 point 3) | `getHover(uri, position)`           |
| `getCompletionsAtPosition`                                                              | replaced                                                              | `getCompletions(uri, position)`     |
| `getCompletionEntryDetails`                                                             | replaced, from the same list matched by name                          | `getCompletions(uri, position)`     |
| `getSignatureHelpItems`                                                                 | replaced                                                              | `getSignatureHelp(uri, position)`   |
| `getDefinitionAndBoundSpan`                                                             | replaced                                                              | `getDefinition(uri, position)`      |
| `findReferences`                                                                        | replaced, regrouped per file with a `definition` per group            | `getReferences(uri, position)`      |
| `getReferencesAtPosition`                                                               | replaced, for clients that call it                                    | `getReferences(uri, position)`      |
| `findRenameLocations`, `getRenameInfo`                                                  | replaced                                                              | `rename(...)`, `prepareRename(...)` |
| `getNavigationTree`, `getNavigationBarItems`                                            | replaced                                                              | `getDocumentSymbols(uri)`           |
| `getEncodedSemanticClassifications`                                                     | replaced, lossily (below)                                             | `getSemanticTokens(uri, range)`     |
| `getCodeFixesAtPosition`, `getCombinedCodeFix`                                          | replaced with nothing, for now                                        | none                                |
| `getDefinitionAtPosition`, `getTypeDefinitionAtPosition`, `getImplementationAtPosition` | replaced, from the same definition list                               | `getDefinition(uri, position)`      |

**`findReferences` is the one tsserver actually calls**, at `typescript.js:189656` in
`getReferencesWorker`, the `references` command path; `getReferencesAtPosition` has no call site
in the server at all. A matrix that decorated only the latter would leave Find All References on
a shader symbol answered by the project's program, silently, with no test failing, which is why
§6 asserts it.

**"Everything else is passed through" was wrong, and the leak is quiet.** A decoration that
spreads the public `LanguageService` and overrides a few members passes the rest through, and
some of the rest answer from the project's program for a directive file. So the remainder is two
explicit lists rather than one sentence.

_Passed through, because they are syntactic and a shader file is still TypeScript syntax:_
`getFormattingEditsForDocument`, `getFormattingEditsForRange`,
`getFormattingEditsAfterKeystroke`, `getIndentationAtPosition`, `getOutliningSpans`,
`getBraceMatchingAtPosition`, `isValidBraceCompletionAtPosition`, `getSmartSelectionRange`,
`getTodoComments`, `getSpanOfEnclosingComment`, `getNameOrDottedNameSpan`,
`getBreakpointStatementAtPosition`, `getLinkedEditingRangeAtPosition`,
`getEncodedSyntacticClassifications`, the comment toggles, and `getProgram`.

_Answered with nothing for a directive file, because the project's program would answer from the
wrong program:_ `getRegionSemanticDiagnostics`, `getDocumentHighlights`, `provideInlayHints`,
`getApplicableRefactors`, `getEditsForRefactor`, `prepareCallHierarchy`,
`provideCallHierarchyIncomingCalls`, `provideCallHierarchyOutgoingCalls`, `organizeImports`,
`getFileReferences`, `getPasteEdits`, `getSupportedCodeFixes`,
`getDocCommentTemplateAtPosition`, `getJsxClosingTagAtPosition`, `mapCode`. Each is a place a
wrong answer is worse than none, and each becomes a real row when the service grows a method for
it.

_Still forwarding, because they are project-wide:_ `getNavigateToItems` and
`getEditsForFileRename`. The rule that decides the two lists above is that a method names one
file, so the plugin can ask whether that file carries the directive and answer for it from the
right program; the TypeShade service answers per document and has no workspace-wide method at
all. These two name no file: the first takes a search string, the second an old path and a new
one, and both are expected to answer across every file in the project. Filtering them would mean
either dropping the whole answer, which breaks workspace symbol search and file rename for the
plain TypeScript the project is mostly made of, or splitting it per file, which needs a
workspace-wide answer from the service to splice back in. The cost of forwarding is named
exactly: a workspace symbol search lists a shader's symbols as the project's program sees them,
which for a `.shade.ts` file means TypeScript's reading of it, and renaming a file rewrites
import specifiers inside shaders using TypeScript's module resolution rather than the service's
`.shade.js` rewriting (§1.7). Both are cosmetic wrong answers in a list the user is scanning,
not a wrong diagnostic or a wrong edit written into a shader, which is the line §3 draws. This
becomes a real row the day the service answers workspace-wide.

`getRegionSemanticDiagnostics` deserves its own sentence because it is invisible from the types.
tsserver calls it at `typescript.js:190872`, guarded by `shouldDoRegionCheck`, whose threshold is
`regionDiagLineCountThreshold = 500` (line 189923), and it is **not declared in
`typescript.d.ts`**. So a plugin that only overrides declared members leaks TypeScript's own
errors back into any shader of 500 lines or more, and only into those, which is the worst
possible size for a bug to appear at. The plugin overrides it through one cast, with the cast's
reason in a comment, and §6 carries a 500-line fixture.

The service's methods already take a uri and a zero-based position and return data
(`src/language-service/service.ts`), and its internal per-feature functions already take a
`ts.LanguageService` and a `ts.SourceFile`, which is the shape a decoration wants. Those
internal functions are not exported from the `./language-service` subpath
(`src/language-service/index.ts` exports the factory, the types, the docs tables, `SHADE_DTS`
and the position helpers), and they do not need to be: the plugin talks to the factory's
instance, never to the compiler's private walk. **The subpath as it stands is sufficient for
every row above.** No compiler change is required for PR 2.

Seven conversions carry all the risk, and each is a decision.

**Diagnostic codes collide with TypeScript's own, across the whole sequential range.**
TypeShade's codes run from `TS8001` (`MISSING_DIRECTIVE`) to `TS8038` (`F64_ENTRY_IO`) with 8011
retired, then `TS8041` (`TEXTURE_ARGUMENT`), `TS8050` to `TS8053`, `TS8068` (`RESERVED_NAME`)
and `TS8099` (`UNSUPPORTED`), all in `src/compiler/ts/codes.ts`, whose header explains the gaps:
codes were handed out in blocks while several branches worked at once, and an unspent number is
never reused. TypeScript's own family occupies 8001 to 8039, verified by extracting every
`diag(...)` code from `typescript/lib/typescript.js`: 2063 distinct codes, maximum 95195. So the
overlap covers the whole sequential range, only TS8041, TS8050 to TS8053, TS8068 and TS8099
fall outside it, and it starts at the first code: TypeScript's 8001 is "You cannot rename elements that are defined in the standard
TypeScript library", which is a rename diagnostic, and this document maps `findRenameLocations`
and `getRenameInfo`. A `ts.Diagnostic.code` is a number, so something has to give.

**Decision: the numeric part, with `source: 'typeshade'`.** TS8003 reports as
`typeshade(8003)`, the spelling the compiler's own documentation uses, and the source field is
what tells the two apart. The collision is then only dangerous through code-keyed behavior,
which is why `getCodeFixesAtPosition` and `getCombinedCodeFix` answer nothing for a directive
file: VS Code asks for fixes by error code, and a fix TypeScript registered for its own 8003
must never be offered for TypeShade's. The range grew from TS8030 to the list above between
`a2240e0` and `ef049e4`, which is why it is written as "TS8001 upward" in the code and
re-checked when the pin moves (§2).

**Severity maps to category.** `'error' | 'warning' | 'information' | 'hint'` to
`ts.DiagnosticCategory.Error | Warning | Message | Suggestion`.

**Syntactic diagnostics are passed through, and deduplicated out of the semantic list.** The
TypeShade service's `getDiagnostics` includes the TypeShade program's own TypeScript syntactic
diagnostics (`getTypeScriptDiagnostics` in `src/language-service/diagnostics.ts` concatenates
`getSyntacticDiagnostics` and `getSemanticDiagnostics`), so returning that list from the
semantic method while also passing the syntactic method through would underline a missing brace
twice. The plugin therefore drops from its semantic answer any diagnostic with
`source: 'typescript'` that the pass-through syntactic answer already carries at the same start
and length. Passing the syntactic pass through is safe because a parse error does not depend on
the library or the ambient declarations, and because the grammar errors that look syntactic are
not: the probe measured TS1206 arriving in `semanticDiag` with `syntaxDiag` empty
(`docs/measurements/tsserver-plugin-load/`).

**Suggestion diagnostics are replaced with nothing.** The suggestion pass answers "how would
this be better JavaScript" (convert to async, unnecessary await, unused label), and a shader file
is not JavaScript. The one member of that family a shader author would want, an unused local,
belongs in the compiler's diagnostics where it can be right about GPU semantics. That is §8
item 6.

**Completion kinds are lossy in one direction.** `TypeshadeCompletionKind` has `attribute`,
`builtin` and `resource`, which `ts.ScriptElementKind` has no spelling for. The mapping is
`keyword` to `keyword`, `type` and `struct` to `interfaceElement`, `function` to
`functionElement`, `variable` and `resource` to `variableElement`, `field` to `memberVariableElement`,
`attribute` and `builtin` to `keyword`, `snippet` to `string` with `isSnippet`. The item's own
`detail` carries the true kind, so nothing is lost from what the user reads; only the icon is
approximate.

**Semantic classifications are lossy in the same way, and worse.** The plugin can only speak
the 2020 classifier legend, whose twelve token types are class, enum, interface, namespace,
typeParameter, type, parameter, variable, enumMember, property, function and member
(`typescript.js:148594`), encoded as `(type + 1) << typeOffset | modifiers` with `typeOffset`
8 and `modifierMask` 255 (line 148590). `TypeshadeSemanticTokenType` has thirteen members
(`src/language-service/types.ts`), so seven have no counterpart: `decorator`, `builtin`,
`resource`, `operator`, `number`, `string` and `keyword`. The modifier legend is narrower
still: TypeScript's is declaration, static, async, readonly, defaultLibrary and local, so
TypeShade's `entry` and `gpu` have nowhere to go either, while `declaration`, `readonly` and
`defaultLibrary` map across. The legend belongs to VS Code's built-in TypeScript extension, so
an extension cannot widen it.

**Decision: map what maps (`type` and `struct` to type, `function` to function, `parameter` to
parameter, `variable` to variable, `property` to property), drop what does not rather than
mislabel it, and leave the richer token set to §8 item 2.** A dropped token is not an unpainted
token: TextMate still colors it. One implementation note, because it is invisible from the
types: `ts.classifier.v2020` exists only at runtime (`typescript.js:152086`) and
`typescript.d.ts` declares no `classifier` namespace, so the plugin hard-codes the twelve
indices and the two encoding constants rather than importing them, with this paragraph's line
numbers as the comment.

**Hover is Markdown on one side and display parts on the other.** `TypeshadeHover.contents` is
one Markdown string (`src/language-service/types.ts`), while `ts.QuickInfo` wants
`displayParts` and `documentation` as `SymbolDisplayPart[]`, and VS Code renders the display
parts inside a TypeScript code fence, so Markdown put there renders as code rather than as
prose. **Decision: the first fenced code block of `contents` becomes `displayParts` with its
fence stripped, and everything after it becomes `documentation`; a hover with no fenced block
puts all of it in `documentation` and leaves `displayParts` empty.** That is what makes the
compiler's type signature read as a signature and its prose read as prose. §6 pins it with an
assertion on a hover whose text has both halves.

## 4. The extension surface

The extension is the shell. Its job is to turn the plugin on, and then to own the three things
tsserver has no protocol for: showing generated shader code, running an entry, and debugging
one.

**Activating the plugin.** `contributes.typescriptServerPlugins` with
`{ "name": "@typeshade/tsserver-plugin", "enableForWorkspaceTypeScriptVersions": true }`. The
second flag matters: without it the plugin loads only under VS Code's bundled TypeScript, and a
repository that pins its own `typescript` (which every repository with a `.shade.ts` file in it
does) would silently get nothing.

**Activation events.** `onLanguage:typescript` only. A `"use typeshade"` file is a TypeScript
file, so that is the event that fires for it, and contributed commands activate implicitly from
VS Code 1.74 onward. The manifest's floor is higher than that anyway,
`engines.vscode: ^1.90.0`, chosen so the extension can rely on implicit activation, on the
stable `DebugAdapterInlineImplementation` API §5 uses, and on a TypeScript extension recent
enough to pass an extension directory as a plugin probe location without caveats. Lowering it
would buy users on releases from 2022, at the cost of guarding three APIs; §8 item 10 keeps the
question open with that answer. No `workspaceContains:**/*.shade.ts`: it would fire the
extension in projects that have shaders but no open shader, for no benefit.

**A workspace with no `tsconfig.json` still works**, which is worth stating because it is how
most people first open a `.shade.ts` file. tsserver puts such a file in an inferred project, and
`InferredProject`'s constructor calls `enableGlobalPlugins` (`typescript.js:184978`), so a
plugin passed through `--globalPlugins`, which is how `contributes.typescriptServerPlugins`
arrives, is enabled there too. §6 carries a fixture with no `tsconfig.json` for exactly this.

**The preview panel.** One `WebviewPanel`, opened beside the editor, with four tabs: WGSL, GLSL
vertex, GLSL fragment, and reflection. Diagnostics are not a tab: they belong to the Problems
view, and a second copy of them in a panel is a second place to be stale. The panel follows the
active editor, updates on edit behind a debounce (default 300 ms), and shows the previous output
greyed out while the current text has an error, because a blank panel while you are mid-edit is
worse than a stale one that says it is stale.

**Where the panel's text comes from is a real decision.** `getCompiledOutput` lives in the
`TypeshadeLanguageService`, and the plugin's instance of that service lives inside the tsserver
process. VS Code gives an extension no supported request channel to a tsserver plugin: the
built-in TypeScript extension's exported API carries `configurePlugin(pluginId, config)`, which
is one-way, and the `typescript.tsserverRequest` command that some extensions use for this is
not part of its API surface. **Decision: the extension runs its own `TypeshadeLanguageService`,
in the extension host, holding only the documents the panel is showing.** The two services are
pure functions of the text they hold, so two of them cannot disagree, only duplicate work. The
alternative, an unsupported command, would put the panel's correctness on an API that can be
removed in a VS Code patch release.

What it costs is mostly fixed rather than mostly per-document, measured with the same harness
as §1.3 (`SHADE_LIMIT=1`): requiring the bundled service 76.8 to 96.8 ms and 11.8 MB, then
building a one-document program and compiling it 87.3 to 94.7 ms and 3.7 MB, for **15.5 MB
retained** against 16.9 MB for the six-document case. So the panel's marginal cost per file is
small and its fixed cost is what matters, and §7 has to count it twice: the plugin's copy in
tsserver and the extension's copy in the extension host, roughly 33 MB across the two processes
on top of what each already holds. Those figures are from the `a2240e0` pin; at `ef049e4` the
same run gave 96.5 to 98.1 ms and 18.6 MB, then 105.7 to 129.2 ms and 6.5 MB, for 25.1 MB
retained against 27.2 MB for six documents, roughly 52 MB across the two processes.

**Commands.**

| Command                    | Title                       | What it does                                                                                                                  |
| -------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `typeshade.showWgsl`       | TypeShade: Show WGSL        | Opens the panel on the WGSL tab for the active file                                                                           |
| `typeshade.showGlsl`       | TypeShade: Show GLSL        | Opens the panel on the GLSL vertex tab                                                                                        |
| `typeshade.showReflection` | TypeShade: Show Reflection  | Opens the panel on the reflection tab (`reflect(module)`, exported from the compiler's root barrel)                           |
| `typeshade.runEntry`       | TypeShade: Run Entry on CPU | Picks an entry from the file's document symbols, asks for the invocation, runs it on the CPU oracle, shows the returned value |
| `typeshade.copyOutput`     | TypeShade: Copy Output      | Copies the active tab's text                                                                                                  |

Every command is enabled only when the active editor's file carries the directive, expressed as
a `when` clause over a context key the extension sets from its own service.

**Status bar.** One item, shown only for a directive file, reading `TypeShade` plus the entry
count, with the compiled-output panel as its command. It is also where a plugin that failed to
load becomes visible: if the extension's own service parses the file as a shader and the
Problems view still shows `ts` diagnostics on it, the plugin did not load, and the item says so
rather than leaving the user to guess.

**Settings.**

| Setting                         | Default | Meaning                                                              |
| ------------------------------- | ------- | -------------------------------------------------------------------- |
| `typeshade.preview.autoUpdate`  | `true`  | Recompile the panel on edit                                          |
| `typeshade.preview.debounceMs`  | `300`   | How long after the last keystroke                                    |
| `typeshade.diagnostics.replace` | `true`  | The plugin's replacement of TypeScript's answers, as an escape hatch |
| `typeshade.debug.precision`     | `f32`   | The stepping engine's arithmetic (§5)                                |
| `typeshade.trace.server`        | `off`   | Plugin request logging, into the TypeScript server log               |

`typeshade.diagnostics.replace` reaches the plugin through `configurePlugin`, which is what that
one-way channel is for.

**What stays out, and why.**

- **A TextMate grammar.** The file is TypeScript and already has one. The site's
  `typeshade-syntax.mjs` exists for a web editor with no TypeScript grammar at all.
- **A separate language id for `.shade.ts`.** It would replace TypeScript's grammar, rename,
  and every other extension that works on TypeScript, to gain an icon.
- **A file icon.** VS Code only lets icon themes decide file icons, and shipping an icon theme
  to decorate one glob would override the user's chosen theme.
- **Formatting.** TypeScript's formatter already formats these files correctly, and the plugin
  passes the formatting methods through.
- **A WGSL or GLSL language server for the output panel.** The panel is read-only.
- **Rendering a shader.** A preview that draws pixels needs a GPU, a pipeline and a host
  runtime, and the compiler deliberately ships none of those (its README: "TypeShade ships the
  authoring and emit surface only").

## 5. The debugger

Designed here, implemented in PR 4, now that PR #35 and PR #41 have merged. Its engine is the
compiler's, on the `./debug` subpath (`src/debug.ts`), and its design is `docs/debugging.md`,
whose §5 decision 8 puts the adapter in this repository and decision 7 puts the engine on that
subpath. The adapter holds no TypeShade semantics: per that document's §2.3, its size is a
measure of drift.

**What the engine offers**, from those two pull requests. PR #35 has
`startDebugSession(module, entry, args, opts)`, returning a `DebugSession` with `stepOver`,
`stepIn`, `stepOut`, `continue` and `setBreakpoints`, plus `pause`, `done`, `result`,
`discarded`, `stubbedIntrinsics` and `precision`. A `DebugPause` carries a reason (`entry`,
`step`, `breakpoint`), the statement's `SourceSpan`, the `stmt`, the frames innermost first,
and the run's bindings as their own map. A `DebugStackFrame` carries the function name, the
function's span, the call's span, the current statement's span, and the frame's locals as a
name-to-value map. A `DebugBreakpoint` is a zero-based line plus an optional file.

PR #41 adds the layer this adapter actually talks to, and it removes work this document
previously assigned to PR 4: `startDebugSessionFromConfig(module, config)`, described in its own
source as "the one call an adapter makes"; `DebugLaunchConfig` and the frozen
`DEBUG_LAUNCH_SCHEMA`, written "for an extension to contribute verbatim"; `resolveInvocation`
and `resolveBindings`, which turn an invocation keyed by WGSL builtin id into the positional
arguments the engine takes; `DebugConfigError`, which collects every fault in a configuration
as sentences before anything runs; and `formatCpuValue` with `createValueFormatter` for
rendering a value in the type the author wrote. The adapter uses all of them rather than
re-implementing any, which is the layering rule this section opened with.

**The adapter, request by request.**

| DAP request                             | Implementation                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`                            | Declares `supportsConfigurationDoneRequest`, `supportsEvaluateForHovers`, `supportsSetVariable: false`, and, importantly, reads the client's `linesStartAt1` and `columnsStartAt1`                                                                                                                                                                                                                                        |
| `launch`                                | Reads the program text, compiles it with the compiler's `compile()`, then hands the module and the launch configuration to `startDebugSessionFromConfig`. A `DebugConfigError` becomes one `output` event per sentence and a failed launch response, because a configuration is wrong in several ways at once                                                                                                             |
| `setBreakpoints`                        | Converts the client's lines to zero-based and calls `setBreakpoints`; a breakpoint is `verified` when the module has a statement whose span starts on that line, which is the engine's own resolution rule                                                                                                                                                                                                                |
| `configurationDone`                     | Either stays on the entry statement (`stopOnEntry`) or calls `continue`                                                                                                                                                                                                                                                                                                                                                   |
| `threads`                               | One thread, id 1, named after the entry and its stage                                                                                                                                                                                                                                                                                                                                                                     |
| `stackTrace`                            | `pause.frames`, mapped one for one, spans converted back to the client's base. `DebugStackFrame.span` is `SourceSpan \| undefined`, and it is undefined for a statement the compiler synthesised (a `while` loop's counter), so a frame with no span reports the function's own `fnSpan` and, failing that, line 0 with a name saying the statement is compiler-generated: a frame that cannot be placed is still a frame |
| `scopes`                                | Three per frame: Locals (the frame's own locals), Parameters (the entry's parameters, from the outermost frame), Bindings (`pause.bindings`)                                                                                                                                                                                                                                                                              |
| `variables`                             | `createValueFormatter` once per session and `formatCpuValue` per value, so a vector, a column-major matrix, a struct and an array read as the author wrote them, in the compiler's own rendering rather than the adapter's. A value that came from `stubbedIntrinsics` is labelled a stand-in rather than a number, which is `docs/debugging.md` §5 decision 4                                                            |
| `next`, `stepIn`, `stepOut`, `continue` | The four engine methods, then a `stopped` event with the new pause's reason                                                                                                                                                                                                                                                                                                                                               |
| `evaluate`                              | `docs/debugging.md` §4.5's synthesised snippet, which is the compiler's own work and not the adapter's. Until it lands, `evaluate` answers only a bare name that the frame has, and says so for anything else                                                                                                                                                                                                             |
| (no request) `terminated`, `exited`     | When a step or `continue` leaves `session.done` true, the adapter emits `output` with `session.result` (or "discarded" when `session.discarded`), then `terminated`. Without this row a finished invocation looks like a hung one: the engine simply stops handing back pauses                                                                                                                                            |
| `disconnect`, `terminate`               | Drops the session                                                                                                                                                                                                                                                                                                                                                                                                         |

**The launch configuration is contributed verbatim.** `contributes.debuggers[0].type` is
`typeshade`, and its `configurationAttributes.launch` is `DEBUG_LAUNCH_SCHEMA`, imported from
`typeshade/debug` and written into the manifest by the build rather than copied by hand. A
schema the extension retyped would drift from the engine that validates against it, and the
frozen export exists precisely so it cannot. `entry` is the only required field there; the
extension adds `program` to its own required list, since the engine is handed a compiled module
and only an adapter needs to know which file to compile.

```jsonc
{
  "type": "typeshade",
  "request": "launch",
  "name": "fs at (100, 50)",
  "program": "${workspaceFolder}/src/hello.shade.ts",
  "entry": "fs",
  "stopOnEntry": true,
  "precision": "f32",
  "derivatives": "zero",
  "invocation": { "position": [100.5, 50.5, 0, 1], "inputs": { "uv": [0.5, 0.25] } },
  "bindings": { "camera": { "pos": [0, 0, 5] } },
}
```

`derivatives` is in that snippet deliberately, and the generated configuration the code lens
starts sets it too. `startDebugSessionFromConfig` passes `gpuStubs: config.derivatives ===
'zero'`, so a configuration that omits it leaves GPU stubs off, and the first step through a
fragment shader calling `fwidth` or `dpdx` throws instead of returning a marked stand-in. The
`stubbedIntrinsics` label in the `variables` row can only ever fire when this field is set,
which is what makes the field part of the contract rather than a nicety.

**The code lens.** "Debug this entry" over every `@vertex`, `@fragment` and `@compute` function,
built from `getDocumentSymbols`, whose entry symbols carry the stage in `detail` and the kind
`entry` (`src/language-service/types.ts`, `TypeshadeDocumentSymbol`). Clicking it starts a
session with a generated configuration rather than requiring a `launch.json`, which is the
difference between a debugger people try and one they do not.

**Where it runs, and how it is carried.** The session class is transport-neutral: it takes DAP
requests as objects and returns responses and events as objects, holding no stream of its own.
Two carriers wrap it. The extension registers it as an inline adapter
(`vscode.DebugAdapterInlineImplementation`) rather than spawning a process, because there is
nothing to isolate (the engine is a synchronous interpreter over one invocation) and a process
would add a protocol hop and a second copy of the compiler bundle. Beside it, a small
`bin/typeshade-dap.js` pumps the same class over stdin and stdout, which is what the protocol
test of §6 drives and what any other DAP client (Neovim's `nvim-dap`, an IntelliJ run
configuration) would use. Neither carrier holds logic, which is the same rule §5 opened with.

## 6. Testing

**The plugin is tested against a real tsserver.** Not against a hand-built
`ts.LanguageService`: the part most likely to break is the loading and decoration contract, and
only the real server exercises it. The harness spawns
`node_modules/typescript/lib/tsserver.js` with `--globalPlugins @typeshade/tsserver-plugin
--pluginProbeLocations <repo root>` and drives the protocol over stdio, newline-delimited JSON
in and `Content-Length`-framed JSON out. `docs/measurements/tsserver-plugin-load/` already
proves that works here: the plugin loads, `create` runs, and `open`, `geterr` and `quickinfo`
answer. `--allowLocalPluginLoads` turned out not to be needed, and both runs are identical.
The scoped name resolves too, which was worth checking rather than assuming, since a scope puts
a path separator inside what looks like a module name: the probe was re-run after the rename
and tsserver reported "Loading @typeshade/tsserver-plugin from <probe location> (resolved to
<probe location>/node_modules)", with the same events as before.

The fixture project holds a directive file, a non-directive file, a directive file with real
TypeShade errors, a pair of directive files where one imports the other, a host file that
imports a shader, a directive file of 500 lines or more, and a second workspace with no
`tsconfig.json` at all.

One assertion this table first carried has been corrected by writing it: "no diagnostic on a
directive file carries `ts` as its source" is false, and should be. The service's own answer is
a MERGED list (`src/language-service/diagnostics.ts` concatenates the front end's diagnostics
with the TypeScript ones its own program reports, after filtering), so a shader calling a
function that does not exist correctly reports both TypeScript's TS2304 and TypeShade's TS8004.
Replacement means the false positives are gone, not that TypeScript is silenced, and the
assertion now says that as a contrast between a server with the plugin and one without.

The last two files are fixtures for specific holes: the 500-line file is the
only size at which `getRegionSemanticDiagnostics` fires (§3), and the config-less workspace is
the inferred-project path most people meet first (§4). The assertions:

| Assertion                                                                                                  | Why it is the one worth making                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| On a clean directive file, zero diagnostics                                                                | The six examples measured 58 false errors without the plugin                                                   |
| On a clean directive file, an unhelped server reports the false-positive classes and this one reports none | Replacement, not merging, stated as the contrast it is                                                         |
| On a directive file with a type error, the expected `TS8xxx` code with `source: 'typeshade'`               | The mapping of §3, end to end                                                                                  |
| An import between two shaders resolves, with no TS2307                                                     | §1.7's `readDocument` rule, and the one place a cross-file answer can be checked                               |
| `quickinfo` on `vec4(...)` is not `any`                                                                    | The probe measured `any` today, which is the user-visible symptom                                              |
| `completionInfo` after `@` offers the attribute list, and inside `@builtin("` the builtin ids              | The context completions are the service's own and must survive the mapping                                     |
| A whole session's events on non-directive files are identical with and without the plugin                  | §1.5, and the only test that can prove a pass-through has no mapping layer in it                               |
| A syntax error is reported once                                                                            | The deduplication of §3                                                                                        |
| `references` on a shader symbol answers from the TypeShade program                                         | tsserver calls `findReferences`, not `getReferencesAtPosition`; decorating only the latter fails silently (§3) |
| A 500-line directive file reports zero diagnostics, with `geterr` twice                                    | `getRegionSemanticDiagnostics` is undeclared in `typescript.d.ts` and fires only past that threshold (§3)      |
| In a workspace with no `tsconfig.json`, a directive file still reports zero diagnostics                    | The inferred-project path, which `enableGlobalPlugins` covers (§4)                                             |
| Deleting the directive brings TypeScript's own errors back, and the document set shrinks                   | The transition §1.1 closes with `closeDocument`; nothing else would catch a leak here                          |
| A hover whose text has a fenced block and prose splits into `displayParts` and `documentation`             | The seventh conversion of §3, which VS Code renders wrongly if the split is wrong                              |
| The tsserver log contains no plugin exception                                                              | A plugin that throws degrades the whole project's TypeScript, silently                                         |

The harness lives in `packages/tsserver-plugin/src/` beside the code, as vitest tests, with the
30 second timeout the root config already sets for exactly this reason.

**The extension is tested with `@vscode/test-electron`, and here is what this container could
verify.** The download works: `downloadAndUnzipVSCode('stable')` fetched VS Code 1.137.0,
327.10 MB, in 11.8 s. Launching it did not: `xvfb-run -a code --version --no-sandbox
--disable-gpu` produced no output and had not exited after 300 s, and without `xvfb-run` the
binary exits immediately with "Missing X server or $DISPLAY". So the plan is: CI runs the
electron tests under `xvfb-run` on `ubuntu-latest`, which is the environment the VS Code team
documents for it, and PR 3 reports whether they pass there. Meanwhile the extension's logic
lives in modules that do not import `vscode` (the compiled-output model, the invocation form's
validation, the launch configuration mapping), each unit-tested with vitest, so a blocked
electron run is a gap in integration coverage and not in coverage.

**The debug adapter is tested at the protocol level**, with `@vscode/debugadapter-testsupport`'s
`DebugClient` over a pipe: launch a fixture shader, set a breakpoint on a known line, assert the
`stopped` event's line, read `scopes` and `variables`, step, and assert the value of a local
after the step. The engine's own correctness is the compiler's `step.test.ts` and
`step-differential.test.ts` (`src/core/debug/`); the adapter's test asserts
translation only, which is the same split §5 states for its size.

**The gate.** Everything above runs in `npm run check`: typecheck, eslint, prettier, the em dash
gate, and vitest. CI runs it on node 20 and node 22, with the submodule checked out. The
electron tests are their own job, because they need `xvfb` and a 327 MB download, and because a
Marketplace publish must not wait on them being flaky.

## 7. Packaging and release

**The plugin ships inside the extension, as a real directory.** Two halves make that work, and
each is verified in a different place. VS Code passes the extension's own directory as a plugin
probe location: `plugins.ts:79` in `extensions/typescript-language-features` collects
`uri: extension.extensionUri` for every extension contributing
`typescriptServerPlugins`, and `spawner.ts:253-259` passes the collected locations to the
server. What tsserver then does with such a location is what this repository's probe measures
directly, and its log says it verbatim: "Loading @typeshade/tsserver-plugin from
/home/user/vscode-typeshade (resolved to /home/user/vscode-typeshade/node_modules)". The probe
passes the flag itself, so it establishes the tsserver half and not the VS Code half, which is
what its own README says under "What is not established".

In this workspace that `node_modules` path is a symlink npm created, and a symlink is not what
should end up in a `.vsix`. So the package step builds the plugin to a single bundled CommonJS
file and copies it, with a minimal `package.json`, into
`packages/vscode-typeshade/node_modules/@typeshade/tsserver-plugin/` as a real directory before
`vsce package` runs.

**What the `.vsix` weighs, counted honestly.** It carries the compiler's language service
twice, once in the plugin bundle and once in the extension bundle. The plugin bundle is 1138 KB
(1,165,707 bytes) as built at `ef049e4`, of which the language service is 1111 KB (498 KB and
470 KB at `a2240e0`, where §1.3 measured);
the extension bundle carries the same service plus `typescript` inlined into it (§2), whose
source is 8.5 MB before esbuild drops what the service never reaches. At run time that is roughly 52 MB of live heap
across two processes at `ef049e4`: about 27 MB in tsserver and about 25 MB in the extension host,
against 17 MB and 15.5 MB at `a2240e0` (§1.3, §4). Sharing one bundled module between the two is possible later and nothing in this layout
prevents it; it is not worth doing before the numbers are a complaint.

**The `.vsix` needs its own LICENSE.** `vsce` packages the directory its manifest sits in, and
`packages/vscode-typeshade/` has no LICENSE file, so the extension would ship without one while
the repository root has MIT. The package step copies the root `LICENSE` in beside the manifest
before packaging.

**The publish workflow is PR 5**, and it is gated three ways: it runs only on a published GitHub
release, only when the release tag matches the extension's `version`, and only with the
`VSCE_PAT` secret present. It runs the full gate first, then `vsce package`, then
`vsce publish --packagePath`, and it uploads the `.vsix` to the release as an asset so a
publish can be reproduced from the exact artifact that was published. No publish on a push to
`main`, ever. Beside it, one `workflow_dispatch` job packages and never uploads, so the
packaging step can be exercised without a release and without touching either registry.

**Both registries, in one run.** The same job publishes to the Visual Studio Marketplace with
`npx @vscode/vsce publish` and then to Open VSX with `npx ovsx publish`, over the one `.vsix`
it already built, so the two registries cannot end up carrying different bytes for one version.
Each token reaches its tool through the environment, `VSCE_PAT` and `OVSX_PAT` read from
`secrets`, never as a command-line argument, so neither can land in a log line. Open VSX second
rather than first because the Marketplace is the one whose failure should stop the run.

**The publishers and the tokens exist.** The owner has created the Marketplace publisher
(display name TypeShade, id `typeshade`, website `https://typeshade.dev`, support
`https://github.com/typeshade/vscode-typeshade/issues`) and added two repository secrets:
`VSCE_PAT`, an Azure DevOps personal access token scoped to Marketplace Manage across all
accessible organizations, and `OVSX_PAT`, an open-vsx.org access token. `packages/vscode-typeshade/package.json` already carries
`"publisher": "typeshade"`, that same `homepage` and that same `bugs.url`, so PR 5 needs no
manifest change to match what was registered.

**Version policy.** The extension's version is its own, and it starts at `0.1.0` on the first
Marketplace release. The compiler's version is not the extension's: a bug fix in the panel
should not wait for a compiler release, and a compiler release should not force an extension
one. What the extension does carry is the pin, stated in two places that cannot drift because
the build writes them: the `CHANGELOG.md` entry for the release, and a `typeshade.version`
value the extension reports in its status bar tooltip and its output channel, read from the
vendored package's own `package.json` at build time. Once the compiler reaches 1.0 the
extension's major follows it, because a compiler major means the language moved.

**The plugin package publishes to npm separately**, as `@typeshade/tsserver-plugin`, so an
editor that is not VS Code can install it with two lines in a `tsconfig.json`. That is not PR 5:
it waits on the compiler publishing, because until then the plugin's own dependency is a
submodule and an npm package cannot carry one honestly.

When it does publish, the workflow is the shape the compiler's own
`.github/workflows/publish.yml` uses (typeshade/typeshade#33), for the reason that file gives:
npm forbids republishing a version, so one bad upload burns the number permanently. Concretely:
the release event is the trigger, a `workflow_call` into this repository's `ci.yml` re-runs the
gate rather than restating it, the release tag must equal the package's `version`, the packed
tarball is installed into a scratch directory and imported before anything is uploaded, and the
publish is `npm publish --provenance --access public`. `--access public` is not optional here
the way it was for an unscoped name: a scoped package defaults to restricted, and a first
publish without it fails on a private-package payment error rather than on anything that reads
like the real cause.

**Authentication is meant to be trusted publishing, once the package exists.** With npm's OIDC
flow the workflow needs no secret at all: the job asks for `id-token: write` and npm verifies it
against a publisher the package owner registers once on npmjs.com, naming this repository and
this workflow file. npm registers a publisher only for a package that already exists, so the
first release goes through an `NPM_ACCESS_TOKEN` secret that the workflow writes to `.npmrc`.
And npm does not yet match the OIDC subject GitHub gives repositories created after 2026-07-15,
this one included ([npm/cli#9969](https://github.com/npm/cli/issues/9969)), so for now the token
publishes every release. `publish-mcp.yml` keeps it as the fallback, and its dry run says when
trusted publishing starts to authenticate (`docs/agents.md` §6). Two more things are the kind
that are only ever learned the expensive way. Trusted publishing needs npm 11.5.1 or newer, so
the job upgrades npm before publishing rather than trusting the runner's bundled 10.x. And
**renaming the workflow file breaks trusted publishing**, because the registered publisher names
the filename, so the file is named once and left alone.

**What the owner had to do once, and nobody else could.** Two of three are done, on
2026-09-14: the Marketplace publisher with its `VSCE_PAT`, and the Open VSX decision with its
`OVSX_PAT`. The third is only needed when the plugin publishes to npm, which is after PR 5: a
token for the first release, then npm trusted publishing for `@typeshade/tsserver-plugin`,
naming `typeshade/vscode-typeshade` and the workflow file. Trusted publishing is the better end
state, since there is nothing to leak and nothing to rotate, but it cannot come first (§8,
item 4).

## 8. Open questions

Each with the answer this document would take, in the shape `docs/debugging.md` §5 uses.

1. **Does the plugin replace the whole of `getCompletionsAtPosition`, including the keyword and
   snippet entries TypeScript would add?** _Suggested: yes, entirely._ A merged list is a list
   where `Promise` and `document` are offered inside a shader. The TypeShade service's own
   completions already include keywords (`docs/language-service-api.md` §5).
2. **The semantic token legend is VS Code's, and seven of TypeShade's thirteen token types
   have no place in it (`decorator`, `builtin`, `resource`, `operator`, `number`, `string`,
   `keyword`), nor do the `entry` and `gpu` modifiers (§3).** _Suggested: drop those tokens for now, and revisit with
   a measurement of what the editor actually looks like, not with a second token provider._ Two
   providers on one document is a coin flip about which one paints.
3. **A `"use typeshade"` file that imports a plain `.ts` file reports "Cannot find module"
   (§1.7).** _Suggested: ask the compiler for a diagnostic that says what is actually wrong, and
   until it exists, leave the honest-but-unhelpful message rather than inventing a code in the
   adapter._ Filing that issue is PR 2's business, when the message has been seen in a real
   editor rather than predicted here.
4. **A standalone LSP server for editors with no tsserver plugin support (§1.2).** _Suggested:
   not now, and not never._ It is a second adapter over the same service; the plugin covers the
   editors that matter first. `docs/agents.md` §0.2 measured the nearer route for agents: the
   plugin loaded by `typescript-language-server` through its `initializationOptions.plugins`,
   which gives every tsserver-based agent tool the plugin's answers, and §1 there adds the third
   adapter this document did not foresee, an MCP server.
5. **Hover on an imported entry inside a host `.ts` file reads as TypeScript sees it (§1.6).**
   _Suggested: leave it, and revisit now that the compiler's `./shade` subpath (on `main` since
   #29) lets a project type-check its shaders as their own tsconfig project, which changes the
   question from "one program or two" to "which project"._
6. **Unused locals in a shader file get no hint, because the suggestion pass is replaced with
   nothing (§3).** _Suggested: ask the compiler for an `UNUSED` diagnostic rather than borrowing
   TypeScript's, since only the compiler knows whether a binding is dead in GPU terms._
7. ~~**Open VSX as well as the Marketplace (§7).**~~ **Decided 2026-09-14: yes**, in the same
   run, with `OVSX_PAT` added beside `VSCE_PAT`. Cursor is a first-class target of this design
   and it reads Open VSX.
8. **Whether the extension's own service should be dropped once VS Code offers a supported
   request channel to a tsserver plugin (§4).** _Suggested: only if it becomes API, and the
   panel is not worth an unsupported command in the meantime._
9. **The residual TS1206 on a `tsconfig.shade.json` build (§1.8).** A project that wants a
   silent `tsc` has to filter that code itself, because only the language service can drop it.
   _Suggested: document the one-line filter in the extension's README when PR 3 ships the
   command that writes the file, and do not build a `tsc` wrapper._ A wrapper is a second build
   tool to maintain for one diagnostic code.
10. **The `engines.vscode` floor of `^1.90.0` (§4).** _Suggested: keep it._ It buys implicit
    activation events, the stable inline debug adapter API, and a TypeScript extension that
    passes extension directories as probe locations without caveats; lowering it would guard
    three APIs to reach users on 2022 releases. Revisit if a real user reports being stuck
    below it.

## Decisions for the owner

Three of these were answered on 2026-09-14, through the orchestrating session, and are kept
here as a record of what was decided rather than a list of what is waiting. One item, the last,
is still open and is not needed until after PR 5.

1. **The Marketplace publisher and the `VSCE_PAT` secret.** Publisher `typeshade`, display name
   TypeShade, and the secret is set, so PR 5 can be run as well as written (§7).
2. **Open VSX: yes.** `OVSX_PAT` is set beside `VSCE_PAT`, and one run publishes to both
   registries over the same `.vsix` (§7).
3. **The plugin's npm name is `@typeshade/tsserver-plugin`.** The owner holds the `@typeshade`
   npm organization (`@typeshade/core` is already reserved there), and the pattern is
   TypeScript's own: the main package stays unscoped (`typeshade`, as `typescript` is) and the
   satellites take the scope, as `@typescript/vfs` and `@typescript/twoslash` do. An earlier
   revision of this document recorded the unscoped name; `packages/tsserver-plugin/package.json`
   and the probe now carry the scoped one, and the probe was re-run to confirm tsserver resolves
   it (§6).
4. **Still open: how the plugin's first release authenticates to npm**, which matters only when
   it publishes, after PR 5. npm registers a trusted publisher only for a package that already
   exists, so trusted publishing cannot come first. `@typeshade/mcp` went out first on a token
   that bypasses two-factor authentication, and its publisher was registered after that
   (`docs/agents.md` §6). npm stops such tokens from publishing in January 2027, so a first
   release after that needs another route, such as a maintainer publishing it by hand with 2FA.
   And trusted publishing does not authenticate this repository at all until npm fixes
   [npm/cli#9969](https://github.com/npm/cli/issues/9969).

Nothing before that step is blocked on an answer.

Last updated: 2026-09-23
