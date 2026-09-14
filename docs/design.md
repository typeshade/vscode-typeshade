# TypeShade in the editor: architecture and decisions

Status: **proposal** for review. Written against `typeshade/typeshade` at `a2240e0`, plus two
branches that have not merged: `claude/d1-debugging-design` (PR #28, the debugging design) and
`claude/d1-stepping-oracle` (PR #35, the `./debug` subpath). It was first written against
`3c0a2d7` and re-checked against `a2240e0` when that arrived: the two commits between them
(#18, a binding read lowering to a varref, and #51, hover) change one thing in the public
surface, an added `CompileTsSourceResult.symbols` field, and nothing in
`src/language-service/index.ts`, so every mapping in §3 stands as written. Every claim about the compiler
names the file it comes from. Nothing here is frozen, and §8 lists what is still open with the
answer this document would take.

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
front-end analysis per document version that diagnostics, symbols, tokens, hover and compiled
output all read (`docs/language-service-api.md` §8).

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
4. **The service decides which TypeScript diagnostics survive.** `docs/language-service-api.md`
   §6 is a table of what the ambient lib cannot silence and what the service therefore filters:
   TS1206 on stage and `@builtin` decorators, and TS2362, TS2363, TS2365 and TS2322 on vector
   and matrix arithmetic, each dropped only when the operand's own type carries one of
   `GPU_BRAND_TAGS` as the checker reports it. `tsc` on its own cannot do that filtering: the
   same branch measured 11 TS1206 left over across the five examples.

On this repository's side there is the workspace of PR 0 and nothing else: a pass-through
plugin skeleton, an extension skeleton, and the gate.

Between the two sits the fact this whole document is about. A TypeShade file needs the program
of point 1, and the editor already has a different one.

## 1. Delivery vehicle

**Decision: a TypeScript server plugin is the core, and the VS Code extension is a thin shell
over it plus the pieces tsserver cannot carry.**

### 1.1 The shape

`typeshade-tsserver-plugin` is a CommonJS module whose module export is the factory tsserver
calls (`ts.server.PluginModule` and `ts.server.PluginCreateInfo` are declared in
`typescript/lib/typescript.d.ts`, not only in the deprecated `tsserverlibrary.d.ts`). tsserver
hands it the project's `LanguageService`, the project's `LanguageServiceHost`, and its own
`typescript` module; the factory returns a service that is the project's own for every file and
TypeShade's for a file carrying the directive.

Inside, the plugin owns one `TypeshadeLanguageService` per project. Documents are synced from
tsserver's own script snapshots, so the plugin never reads a file itself: on each request for a
file it wants to answer for, it compares `info.languageServiceHost.getScriptVersion(fileName)`
with the version it last stored and calls `openDocument` or `updateDocument` with
`getScriptSnapshot(fileName).getText(0, length)` when they differ. Documents are pruned when
`info.project.getProjectVersion()` changes and the file is no longer in the project's file
names, which is the only moment the set can shrink.

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

The measurement and its script are in `docs/measurements/two-program-cost/`, which reports two
runs, on `3c0a2d7` and on `a2240e0`, so a reader can see which numbers are stable. On a fixture
of 150 plain TypeScript modules plus the compiler's six `.shade.ts` examples, under node
v24.3.0 with typescript 5.6.3:

| Number                                                           | Value                     |
| ---------------------------------------------------------------- | ------------------------- |
| Building the TypeShade program and answering for all six shaders | 59.5 to 63.3 ms           |
| The same with 60 shader files                                    | 206.3 to 212.2 ms         |
| Live heap the TypeShade program retains, 6 shaders               | 3.6 to 4.4 MB             |
| The same with 60 shader files                                    | 4.0 to 8.4 MB             |
| One edit plus diagnostics for a shader file, TypeShade program   | 5.6 to 7.2 ms             |
| The same file answered by the project program                    | 14.4 to 40.9 ms           |
| False semantic errors the project program reports on the six     | 58, exactly, in every run |

A range rather than a figure wherever the runs disagreed, which is the honest reading of a
shared four-core container: the diagnostic counts are exact and identical across runs, the
second program's cold and warm costs agree closely, and the two that wander are its retained
heap and the project program's warm cost. What matters survives either reading, since the
question is whether a second program is affordable and not whether it costs 3.6 MB or 4.4 MB.

The cost is small for a structural reason rather than a lucky one: the second program holds the
shader files and `SHADE_DTS`, and nothing else. The fixture's 150 host modules are not in it,
which is why both the time and the memory scale on the shader count alone (§1.7 is why that is a
language fact and not a configuration choice). A project ten times larger costs the second
program nothing.

Warm cost being lower than the project program's for the same file is worth one sentence, since
it looks like a mistake: the TypeShade program re-checks one small file against a 265-line
ambient lib (`SHADE_DTS` is 11015 characters over 265 lines, measured through the subpath),
while the project program re-checks the same file against `lib.es2022` plus `lib.dom` inside a
156-file program.

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
reads as TypeScript sees it. §8 item 5 keeps a better answer open once the compiler ships
`shade.d.ts` as a real file (it does on `claude/c6-ambient-lib`, as the `./shade` types-only
subpath), because a host project can then put its shader sources in a separate `tsconfig` and
the question stops being about one program.

### 1.7 A `.shade.ts` file that imports a plain `.ts` file

**Decision: the plugin serves the TypeShade program only files that carry the directive. A
relative import of a non-directive file resolves to nothing, and TypeScript reports it from the
shader file as an unresolved module.**

The reason is §0 point 2 again: a plain TypeScript module is written for the standard library,
and the TypeShade program has none. Pulling it in would put its own text under `lib: []` and
produce errors inside a file the user never asked to be a shader. The compiler's own multi-file
story is unsettled (`docs/language-service-api.md` §11: `compileTsSources` exists in two
incompatible forms), so the editor is not the place to invent one.

Concretely, the plugin's `readDocument` host hook (`TypeshadeLanguageServiceHost.readDocument`,
`src/language-service/host.ts`) reads the file through tsserver's host, parses its first
statements for the directive, and returns the text only when the directive is there. The
resulting message ("Cannot find module './util.js'") is honest but unhelpful, and improving it
needs a diagnostic the compiler owns rather than one the adapter invents, which is §8 item 3.

## 2. The compiler dependency before 0.1.0

The compiler is not on npm. Its `package.json` `exports` point at TypeScript sources
(`"." : "./src/index.ts"`), its name becomes `typeshade` on the publishing branches
(`claude/c6-rename` through `claude/c6-publish`), and a `dist/` layout arrives with the
`./shade` subpath on `claude/c6-ambient-lib`.

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
- `packages/tsserver-plugin` and `packages/vscode-typeshade` import `typeshade` and
  `typeshade/language-service` as package specifiers. The workspace root maps those two
  specifiers to `vendor/typeshade` through `tsconfig` `paths` for type-checking and through an
  esbuild alias for the bundle, in one place each, so the eventual npm dependency deletes two
  entries and changes no source file.
- The bundle is esbuild with `platform: 'node'`, `format: 'cjs'`, `target: 'node20'`, and
  `external: ['typescript', 'vscode']`. `typescript` is external because the plugin must use
  the host's instance (§3) and the extension must not ship a second copy; `vscode` is external
  because the extension host provides it.
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
§3's table in the same pull request. Nothing else may move the pin: no floating branch, no
`--remote` update in CI.

## 3. The feature matrix

The compiler's own layering rule (`docs/language-service-api.md` §1) is that adapters convert
and the service decides. The plugin is an adapter, so this table is a mapping table and every
row's right column is a call into `TypeshadeLanguageService`.

Two general rules apply to every row. For a file without the directive, the plugin calls the
project's method and returns its result unchanged (§1.5). For a file with the directive, the
plugin answers from the TypeShade service and never merges the two, because merging is how a
false positive survives.

| `ts.LanguageService` method                                                             | Directive file                                                        | Service call                        |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------- |
| `getSemanticDiagnostics`                                                                | replaced, minus the entries the syntactic pass already reported       | `getDiagnostics(uri)`               |
| `getSyntacticDiagnostics`                                                               | passed through                                                        | none                                |
| `getSuggestionDiagnostics`                                                              | replaced with nothing                                                 | none                                |
| `getQuickInfoAtPosition`                                                                | replaced, so the compiler's own type reaches the tooltip (§0 point 3) | `getHover(uri, position)`           |
| `getCompletionsAtPosition`                                                              | replaced                                                              | `getCompletions(uri, position)`     |
| `getCompletionEntryDetails`                                                             | replaced, from the same list matched by name                          | `getCompletions(uri, position)`     |
| `getSignatureHelpItems`                                                                 | replaced                                                              | `getSignatureHelp(uri, position)`   |
| `getDefinitionAndBoundSpan`                                                             | replaced                                                              | `getDefinition(uri, position)`      |
| `getReferencesAtPosition`                                                               | replaced                                                              | `getReferences(uri, position)`      |
| `findRenameLocations`, `getRenameInfo`                                                  | replaced                                                              | `rename(...)`, `prepareRename(...)` |
| `getNavigationTree`                                                                     | replaced                                                              | `getDocumentSymbols(uri)`           |
| `getEncodedSemanticClassifications`                                                     | replaced, lossily (below)                                             | `getSemanticTokens(uri, range)`     |
| `getCodeFixesAtPosition`                                                                | replaced with nothing, for now                                        | none                                |
| `getDefinitionAtPosition`, `getTypeDefinitionAtPosition`, `getImplementationAtPosition` | replaced, from the same definition list                               | `getDefinition(uri, position)`      |
| everything else                                                                         | passed through                                                        | none                                |

The service's methods already take a uri and a zero-based position and return data
(`src/language-service/service.ts`), and its internal per-feature functions already take a
`ts.LanguageService` and a `ts.SourceFile`, which is the shape a decoration wants. Those
internal functions are not exported from the `./language-service` subpath
(`src/language-service/index.ts` exports the factory, the types, the docs tables, `SHADE_DTS`
and the position helpers), and they do not need to be: the plugin talks to the factory's
instance, never to the compiler's private walk. **The subpath as it stands is sufficient for
every row above.** No compiler change is required for PR 2.

Six conversions carry all the risk, and each is a decision.

**Diagnostic codes collide with TypeScript's own.** TypeShade's codes are the strings `TS8003`
to `TS8030` (`src/compiler/ts/codes.ts`), and TypeScript uses 8001 to 8039 for its own
"can only be used in TypeScript files" family: TS8003 is `TYPE_MISMATCH` in TypeShade and
"export can only be used in TypeScript files" in TypeScript, verified by extracting every
`diag(...)` code from `typescript/lib/typescript.js` (2063 distinct codes, 8001 to 8039 present,
maximum 95195). A `ts.Diagnostic.code` is a number, so something has to give. **Decision: the
numeric part, with `source: 'typeshade'`.** TS8003 reports as `typeshade(8003)`, which is the
spelling the compiler's own documentation uses, and the source field is what tells the two
apart. The collision is then only dangerous through code-keyed behavior, which is why
`getCodeFixesAtPosition` answers nothing for a directive file: VS Code asks for fixes by error
code, and a fix TypeScript registered for its own 8003 must never be offered for TypeShade's.

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
the 2020 classifier legend (`ts.classifier.v2020.TokenType`), whose types are class, enum,
interface, namespace, typeParameter, type, parameter, variable, enumMember, property, function
and member. TypeShade's `decorator`, `builtin`, `resource`, `operator`, `number` and `string`
have no place in it, and the legend belongs to VS Code's built-in TypeScript extension, so an
extension cannot widen it. **Decision: map what maps (`type` and `struct` to type, `function` to
function, `parameter` to parameter, `variable` to variable, `property` to property), drop what
does not rather than mislabel it, and leave the richer token set to §8 item 2.** A dropped token
is not an unpainted token: TextMate still colors it.

## 4. The extension surface

The extension is the shell. Its job is to turn the plugin on, and then to own the three things
tsserver has no protocol for: showing generated shader code, running an entry, and debugging
one.

**Activating the plugin.** `contributes.typescriptServerPlugins` with
`{ "name": "typeshade-tsserver-plugin", "enableForWorkspaceTypeScriptVersions": true }`. The
second flag matters: without it the plugin loads only under VS Code's bundled TypeScript, and a
repository that pins its own `typescript` (which every repository with a `.shade.ts` file in it
does) would silently get nothing.

**Activation events.** `onLanguage:typescript` only. A `"use typeshade"` file is a TypeScript
file, so that is the event that fires for it, and commands activate implicitly in VS Code 1.74
and later. No `workspaceContains:**/*.shade.ts`: it would fire the extension in projects that
have shaders but no open shader, for no benefit.

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
in the extension host, holding only the documents the panel is showing.** One document, not a
project, so the cost is below the 4.4 MB and 63.3 ms that six files measured (§1.3). The two
services are pure functions of the text they hold, so two of them cannot disagree, only
duplicate work. The alternative, an unsupported command, would put the panel's correctness on an
API that can be removed in a VS Code patch release.

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

Designed here, implemented in PR 4, after PR #35 merges. Its engine is the compiler's, on the
`./debug` subpath (`src/debug.ts` on `claude/d1-stepping-oracle`), and its design is
`docs/debugging.md`, whose §5 decision 8 puts the adapter in this repository and decision 7 puts
the engine on that subpath. The adapter holds no TypeShade semantics: per that document's §2.3,
its size is a measure of drift.

**What the engine offers.** `startDebugSession(module, entry, args, opts)` returns a
`DebugSession` with `stepOver`, `stepIn`, `stepOut`, `continue` and `setBreakpoints`, plus
`pause`, `done`, `result`, `discarded`, `stubbedIntrinsics` and `precision`. A `DebugPause`
carries a reason (`entry`, `step`, `breakpoint`), the statement's `SourceSpan`, the `stmt`, the
frames innermost first, and the run's bindings as their own map. A `DebugStackFrame` carries the
function name, the function's span, the call's span, the current statement's span, and the
frame's locals as a name-to-value map. A `DebugBreakpoint` is a zero-based line plus an optional
file.

**The adapter, request by request.**

| DAP request                             | Implementation                                                                                                                                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`                            | Declares `supportsConfigurationDoneRequest`, `supportsEvaluateForHovers`, `supportsSetVariable: false`, and, importantly, reads the client's `linesStartAt1` and `columnsStartAt1`                                                                                                          |
| `launch`                                | Reads the program text, compiles it with the compiler's `compile()`, then `startDebugSession` with the mapped invocation and bindings                                                                                                                                                       |
| `setBreakpoints`                        | Converts the client's lines to zero-based and calls `setBreakpoints`; a breakpoint is `verified` when the module has a statement whose span starts on that line, which is the engine's own resolution rule                                                                                  |
| `configurationDone`                     | Either stays on the entry statement (`stopOnEntry`) or calls `continue`                                                                                                                                                                                                                     |
| `threads`                               | One thread, id 1, named after the entry and its stage                                                                                                                                                                                                                                       |
| `stackTrace`                            | `pause.frames`, mapped one for one, spans converted back to the client's base                                                                                                                                                                                                               |
| `scopes`                                | Three per frame: Locals (the frame's own locals), Parameters (the entry's parameters, from the outermost frame), Bindings (`pause.bindings`)                                                                                                                                                |
| `variables`                             | The CPU value model rendered in shader types: a vector as its components, a matrix column-major as the IR is, a struct by field name, an array by index. A value that came from `stubbedIntrinsics` is labelled a stand-in rather than a number, which is `docs/debugging.md` §5 decision 4 |
| `next`, `stepIn`, `stepOut`, `continue` | The four engine methods, then a `stopped` event with the new pause's reason                                                                                                                                                                                                                 |
| `evaluate`                              | `docs/debugging.md` §4.5's synthesised snippet, which is the compiler's own work and not the adapter's. Until it lands, `evaluate` answers only a bare name that the frame has, and says so for anything else                                                                               |
| `disconnect`, `terminate`               | Drops the session                                                                                                                                                                                                                                                                           |

**The launch configuration.** The schema is `docs/debugging.md` §4, and the compiler's milestone
M3 bakes it as a published type plus a JSON Schema. Until then, the extension contributes the
same shape by hand, and PR 4's body says which fields it covers. The contributed
`debuggers` entry is `type: "typeshade"`, with `program` and `entry` required and everything
else defaulted:

```jsonc
{
  "type": "typeshade",
  "request": "launch",
  "name": "fs at (100, 50)",
  "program": "${workspaceFolder}/src/hello.shade.ts",
  "entry": "fs",
  "stopOnEntry": true,
  "precision": "f32",
  "invocation": { "position": [100.5, 50.5, 0, 1], "inputs": { "uv": [0.5, 0.25] } },
  "bindings": { "camera": { "pos": [0, 0, 5] } },
}
```

**The one gap worth naming now.** `startDebugSession` takes the entry's parameters
**positionally** (`args`, "short or sparse is filled with zeros"), while the launch
configuration is keyed by WGSL builtin id and by input name, because that is what
`docs/debugging.md` §4.2 decided and what `reflect()` reports. Something has to map one to the
other, and until the compiler's M3 ships the invocation builder, that something is the adapter,
using `reflect(module)`'s entry IO to order the keys. That is a piece of TypeShade knowledge in
an adapter, which §2.3 of the debugging document says should not happen, so PR 4 writes it as
one function with a comment naming M3 as its replacement, and the pull request tells the
orchestrator.

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
`node_modules/typescript/lib/tsserver.js` with `--globalPlugins typeshade-tsserver-plugin
--pluginProbeLocations <repo root>` and drives the protocol over stdio, newline-delimited JSON
in and `Content-Length`-framed JSON out. `docs/measurements/tsserver-plugin-load/` already
proves that works here: the plugin loads, `create` runs, and `open`, `geterr` and `quickinfo`
answer. `--allowLocalPluginLoads` turned out not to be needed, and both runs are identical.

The fixture project holds a directive file, a non-directive file, a directive file with real
TypeShade errors, a pair of directive files where one imports the other, and a host file that
imports a shader. The assertions, on each:

| Assertion                                                                                     | Why it is the one worth making                                                   |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| On a clean directive file, zero diagnostics                                                   | The six examples measured 58 false errors without the plugin                     |
| On a directive file, no diagnostic carries `ts` as its source                                 | Replacement, not merging                                                         |
| On a directive file with a type error, the expected `TS8xxx` code with `source: 'typeshade'`  | The mapping of §3, end to end                                                    |
| `quickinfo` on `vec4(...)` is not `any`                                                       | The probe measured `any` today, which is the user-visible symptom                |
| `completionInfo` after `@` offers the attribute list, and inside `@builtin("` the builtin ids | The context completions are the service's own and must survive the mapping       |
| A whole session's events on non-directive files are identical with and without the plugin     | §1.5, and the only test that can prove a pass-through has no mapping layer in it |
| A syntax error is reported once                                                               | The deduplication of §3                                                          |
| The tsserver log contains no plugin exception                                                 | A plugin that throws degrades the whole project's TypeScript, silently           |

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
`step-differential.test.ts` on `claude/d1-stepping-oracle`; the adapter's test asserts
translation only, which is the same split §5 states for its size.

**The gate.** Everything above runs in `npm run check`: typecheck, eslint, prettier, the em dash
gate, and vitest. CI runs it on node 20 and node 22, with the submodule checked out. The
electron tests are their own job, because they need `xvfb` and a 327 MB download, and because a
Marketplace publish must not wait on them being flaky.

## 7. Packaging and release

**The plugin ships inside the extension, as a real directory.** VS Code passes the extension's
own path as a plugin probe location, and tsserver resolves the plugin name against
`node_modules` under it, which the probe run shows verbatim ("Loading
typeshade-tsserver-plugin from /home/user/vscode-typeshade (resolved to
/home/user/vscode-typeshade/node_modules)"). In this workspace that path is a symlink npm
created, and a symlink is not what should end up in a `.vsix`. So the package step builds the
plugin to a single bundled CommonJS file and copies it, with a minimal `package.json`, into
`packages/vscode-typeshade/node_modules/typeshade-tsserver-plugin/` as a real directory before
`vsce package` runs. The `.vsix` then carries one copy of the compiler bundle in the plugin and
one in the extension, which is the price of the §4 decision to run a service in the extension
host; if that grows uncomfortable, the two can share a bundled module later, and nothing about
the layout prevents it.

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

**The plugin package publishes to npm separately**, as `typeshade-tsserver-plugin`, so an
editor that is not VS Code can install it with two lines in a `tsconfig.json`. That is not PR 5:
it waits on the compiler publishing, because until then the plugin's own dependency is a
submodule and an npm package cannot carry one honestly.

**What the owner had to do once, and nobody else could.** Both are done, on 2026-09-14:
the Marketplace publisher with its `VSCE_PAT`, and the Open VSX decision with its `OVSX_PAT`.
Nothing in PR 5 waits on a person now.

## 8. Open questions

Each with the answer this document would take, in the shape `docs/debugging.md` §5 uses.

1. **Does the plugin replace the whole of `getCompletionsAtPosition`, including the keyword and
   snippet entries TypeScript would add?** _Suggested: yes, entirely._ A merged list is a list
   where `Promise` and `document` are offered inside a shader. The TypeShade service's own
   completions already include keywords (`docs/language-service-api.md` §5).
2. **The semantic token legend is VS Code's, and TypeShade's `decorator`, `builtin` and
   `resource` have no place in it (§3).** _Suggested: drop those tokens for now, and revisit with
   a measurement of what the editor actually looks like, not with a second token provider._ Two
   providers on one document is a coin flip about which one paints.
3. **A `"use typeshade"` file that imports a plain `.ts` file reports "Cannot find module"
   (§1.7).** _Suggested: ask the compiler for a diagnostic that says what is actually wrong, and
   until it exists, leave the honest-but-unhelpful message rather than inventing a code in the
   adapter._ Filing that issue is PR 2's business, when the message has been seen in a real
   editor rather than predicted here.
4. **A standalone LSP server for editors with no tsserver plugin support (§1.2).** _Suggested:
   not now, and not never._ It is a second adapter over the same service; the plugin covers the
   editors that matter first.
5. **Hover on an imported entry inside a host `.ts` file reads as TypeScript sees it (§1.6).**
   _Suggested: leave it, and revisit when the compiler's `./shade` subpath
   (`claude/c6-ambient-lib`) lets a project type-check its shaders as their own tsconfig
   project, which changes the question from "one program or two" to "which project"._
6. **Unused locals in a shader file get no hint, because the suggestion pass is replaced with
   nothing (§3).** _Suggested: ask the compiler for an `UNUSED` diagnostic rather than borrowing
   TypeScript's, since only the compiler knows whether a binding is dead in GPU terms._
7. ~~**Open VSX as well as the Marketplace (§7).**~~ **Decided 2026-09-14: yes**, in the same
   run, with `OVSX_PAT` added beside `VSCE_PAT`. Cursor is a first-class target of this design
   and it reads Open VSX.
8. **Whether the extension's own service should be dropped once VS Code offers a supported
   request channel to a tsserver plugin (§4).** _Suggested: only if it becomes API, and the
   panel is not worth an unsupported command in the meantime._

## Decisions for the owner

All three that were the owner's rather than an implementer's were answered on 2026-09-14,
through the orchestrating session. They are kept here as a record of what was decided, not as a
list of what is waiting.

1. **The Marketplace publisher and the `VSCE_PAT` secret.** Publisher `typeshade`, display name
   TypeShade, and the secret is set, so PR 5 can be run as well as written (§7).
2. **Open VSX: yes.** `OVSX_PAT` is set beside `VSCE_PAT`, and one run publishes to both
   registries over the same `.vsix` (§7).
3. **The plugin's npm name is the unscoped `typeshade-tsserver-plugin`**, matching the
   compiler's unscoped `typeshade`. That is the name this document already used and the one
   `packages/tsserver-plugin/package.json` already carries, so nothing changes.

Nothing in this document is blocked on an answer.

Last updated: 2026-09-14
