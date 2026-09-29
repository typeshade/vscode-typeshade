# The Playground and the editor: one workspace in two places

Status: **accepted**, and Stages 1 and 2 are built (§7). It answers the owner's request to carry the site's Playground
into VS Code: work on a shader in the browser, continue it in the editor with the extension, and
bring it back, and to have a VS Code in the browser as well. The pinned compiler is
`typeshade/typeshade` at `7c274e2` (it was `88ba8ad` when Stage 1 was written); the site is
`typeshade/typeshade.github.io` at `1ef8fd6`, whose Playground has file tabs, passes (compiler
change 0026), texture bindings and short links (typeshade.github.io#108, #115, #117). §7 lists
what is built, and §6 what the owner decided.

## 0. What exists on both sides

**The Playground** (site `src/scripts/playground.ts`) holds a workspace: a main file, the files
beside it, and a pass graph, an ordered list of `{ name, path }` whose files are drawn before the
main file each frame. It writes the workspace into the page's hash:

- `code=`, the main file;
- `files=`, a JSON object of the other files by path;
- `passes=name:path,...`, the graph in draw order.

Each value is `encodeSource` (site `src/scripts/source-link.ts`): `deflate-raw`, then base64url,
behind a one-letter prefix that says which. Share stores that hash with the Worker and copies a
short link, `/s/<id>`, which redirects to the Playground with the hash
(site `worker/index.ts`). The canvas is drawn by site `src/lib/shader-runtime.ts` (WebGPU, WebGL2
and the CPU oracle), and the language service runs in a web worker from the compiler's
`./language-service` export, the same service this repository's plugin wraps.

**The extension** (this repository, `docs/design.md` §4) is a desktop VS Code extension: the
tsserver plugin replaces TypeScript's answers on a `"use typeshade"` file, and a webview panel
shows the WGSL, the GLSL and the reflection. It drew no pixels until Stage 2 (§3, §7), it is not
a web extension, and it is not published yet: the Marketplace and Open VSX return nothing for
`typeshade.vscode-typeshade`, and the publish workflow is `docs/design.md` §7's PR 5.

## 1. What a reader should be able to do

1. **Playground to editor.** From the Playground, one button gives a folder that opens in VS Code
   as a project: the files, a `tsconfig.json`, the pass graph, and the extension recommended.
   With the extension installed, a link opens the same workspace straight into a new folder.
2. **Editor to Playground.** In VS Code, one command turns the open workspace into a Playground
   link, so a shader written in the editor can be shared and drawn in any browser.
3. **See it draw in the editor.** The extension's panel draws the shader the way the Playground
   does, passes included, and redraws on edit.
4. **VS Code in the browser.** The same project opened on vscode.dev or github.dev gets the
   diagnostics and the panel, with nothing installed but the extension.

Each is a stage below, in the order that each makes the next cheaper.

## 2. Stage 1: the round trip

### 2.1 The workspace on disk

A folder needs to say what the hash says: which file is the main one and which files are passes.
**Proposed: a `typeshade.json` at the folder's root.**

```json
{
  "main": "main.shade.ts",
  "passes": [{ "name": "trail", "file": "passes/trail.shade.ts" }]
}
```

`passes` is the shape compiler change 0026 gave the `@example` block, so a reader who knows one
knows the other. The file is host data, as 0026 argues the graph is: the compiler never reads it,
and no rule of `docs/language-design.md` changes. Bindings (a dropped picture on a texture) stay
out of the first version: a picture is not text, and the hash does not carry one either.

The alternative, a `@workspace` comment block in the main file like `@example`, keeps one file
fewer but makes the main file the only place the graph can live, and a reader who renames it
loses the graph. A file of its own also gives the extension a `workspaceContains:typeshade.json`
activation event that means exactly "this is a TypeShade project".

### 2.2 Playground to editor

- **Download** (site): a button beside Share that writes a zip of the workspace, `typeshade.json`,
  a `tsconfig.json` that includes `**/*.shade.ts`, and `.vscode/extensions.json` recommending
  `typeshade.vscode-typeshade`. It needs no Worker and no extension, so it works today for anyone
  with VS Code.
- **Open in VS Code** (site and extension): a `vscode://typeshade.vscode-typeshade/open?link=<short link>`
  link. The extension registers a `UriHandler`, fetches the short link, reads the hash from the
  redirect, decodes it with the same `encodeSource` format, asks for a folder, writes the files
  and `typeshade.json`, and opens it. The button is shown only as a second choice beside Download,
  since a browser cannot tell whether the extension is installed.

### 2.3 Editor to Playground

`TypeShade: Open in Playground` reads `typeshade.json` (or, without one, takes the active file as
the main file and the directive files it imports as the files beside it), encodes the workspace
into the hash format of §0, and opens `https://typeshade.dev/playground/#...` in the browser.
Posting it to the Worker for a short link is a second step, left out of the first version so the
extension sends nothing to a server without the reader seeing where it goes.

### 2.4 The link format becomes a contract

Today the hash is the site's private format. Once the extension writes it, a change on either side
breaks the other. **Proposed:** the site's `source-link.ts` and the hash parameters are written
down in the site's `DESIGN.md` as a versioned format, and this repository's tests decode a link
the site's check produced, and the reverse, so neither can drift without a red check.

## 3. Stage 2: the panel draws

The panel gains a fifth tab, **Canvas**, that draws the active workspace: the passes in order,
then the main file, with `time`, `resolution`, `mouse`, `frame` and `timeDelta` as the site's
live-shader contract fills them, and a checker texture on a `texture_2d<f32>` that is not a pass.

Where the drawing code comes from is the decision:

- **The compiler's public runtime (change 0025).** It is implemented at the pin,
  `typeshade/runtime`: it is the right home, since it is the runtime the compiler ships to every
  host, and the site means to move onto it too (0026, "It lines up with the public runtime").
- **A copy of the site's `shader-runtime.ts`.** It works today, 2,160 lines, and would be a
  second copy of code that already has one, drifting from the first the day it is copied.

**Decided: wait for 0025 rather than copy** (§6, item 3). It has landed: the pin carries it, and
§7 records how the tab uses it. The runtime is WebGPU only in version 1, so the tab is too: a
webview with no adapter says so and draws nothing. Whether a webview has WebGPU depends on
Electron's flags and is measured, not assumed, the same way §1.3 of `docs/design.md` measures
memory; §7 has the measurement. The WebGL2 tier that the earlier draft of this section counted
on ("a webview has WebGL2 on every platform VS Code runs on") waits for the runtime's own WebGL2
proposal (0025, "What it does not do"), which is the only place it can be written once.

## 4. Stage 3: VS Code in the browser

Two routes, and only one is proposed.

**The extension as a web extension, on vscode.dev and github.dev.** VS Code treats an extension
as a web extension only when its manifest has a `browser` entry, and a manifest that contributes
`typescriptServerPlugins` does not qualify on its own
([Web Extensions](https://code.visualstudio.com/api/extension-guides/web-extensions)). TypeScript
gained an asynchronous plugin import for its web server in 4.8
([TypeScript#47376](https://github.com/microsoft/TypeScript/issues/47376); the
`importServicePluginAsync` path is in `typescript.js`), but whether VS Code's web TypeScript
extension loads a plugin from an installed web extension is not established here. **Proposed: a
probe first**, in `docs/measurements/web-plugin-load/` beside the desktop one: run
`@vscode/test-web` with a `browser` build of the extension and read the TypeScript log for the
plugin's load line. Then:

- if the plugin loads, the web build is the desktop one with a `browser` entry, the service
  bundled as ESM, and the file reader going through `vscode.workspace.fs`;
- if it does not, the web build runs its own service (as the panel already does, §4 of
  `docs/design.md`) and publishes its diagnostics itself. On the web, TypeScript's own answers
  then sit beside the extension's, which is the cost §1.2 of `docs/design.md` describes, and the
  probe measures how many false errors that is before anything ships.

The compiler's language service already runs in a browser worker on the site, so the service
itself is not the risk; the plugin's host is.

**A VS Code of our own on the site** (a VS Code for the Web build served from typeshade.dev with
the extension installed) is not proposed. It is tens of megabytes to host and keep current for
what the Playground's Monaco editor already gives a reader, and vscode.dev already opens any
public GitHub repository with the extension.

## 5. Order and what each stage owes

| Stage | Repository | Work                                                                           | Waits on                 |
| ----- | ---------- | ------------------------------------------------------------------------------ | ------------------------ |
| 1a    | site       | Download as a folder; `typeshade.json`; the link format in `DESIGN.md`         | nothing                  |
| 1b    | this one   | Move the pin to carry 0026; `typeshade.json`; Open in Playground; `UriHandler` | 1a's format              |
| 1c    | this one   | Publish the extension (`docs/design.md` §7, PR 5)                              | the owner's go-ahead     |
| 1d    | site       | Open in VS Code beside Download                                                | 1b and 1c                |
| 2     | this one   | The Canvas tab over the compiler's runtime (built, §7)                         | compiler change 0025     |
| 3a    | this one   | The web plugin probe                                                           | nothing                  |
| 3b    | this one   | The web build, by the probe's answer                                           | 3a, and 2 for the canvas |

No stage changes a rule, an export, a surface section or a diagnostic code of the compiler, so
none needs a compiler change proposal. If the owner prefers the graph inside the main file
(§2.1's alternative), that is still host data and still needs none.

## 6. Decisions for the owner

Decided on 2026-09-28, in the orchestrating session: the owner took every suggestion.

1. **`typeshade.json` is the workspace file (§2.1).**
2. **The extension is published (§5, 1c)**: PR 5 of `docs/design.md` §7 is written now, and
   0.1.0 is released once 1b has merged.
3. **Stage 2 waits for 0025 (§3)**, and the site's runtime is not copied.
4. **Stage 3 starts with the probe (§4)**, and no VS Code build is hosted on the site.

## 7. What is built

- **1a**, the site's download and its link format written down: typeshade.github.io#123.
- **1b**, this repository: `packages/vscode-typeshade/src/workspace-link.ts` reads and writes
  the link and the folder, and its tests hold it to a link the site's own encoder wrote;
  `bridge.ts` adds Open in Playground, Open Playground Link and the `vscode://` handler. Open in
  Playground takes the main file and the passes from `typeshade.json` when the folder has one,
  else the active file, and the files beside them are the ones they import, followed through
  their relative imports. The pin does not move for it: the extension reads and writes the
  graph and draws nothing, so 0026 owes it nothing until Stage 2.
- **1c**, the publish workflow (`docs/design.md` §7): `.github/workflows/publish-extension.yml`
  and `scripts/package-extension.mjs`. The extension's version is 0.1.0, and pushing the tag
  `extension-v0.1.0` on `main` publishes it to both registries.
- **Link handling.** A pasted link and the `vscode://` handler's `link` come from any web page,
  so `workspace-link.ts` decides what may cost a request (`planLink`): only a short link
  (`/s/<id>`) whose origin is exactly `https://typeshade.dev` is fetched, and only to read its
  redirect, which `shortLinkTarget` accepts only when it leads back to that origin. Every other
  link is read from its own fragment and never fetched. `readLink` then holds every path in the
  link's `files` to the Playground's own rule (a relative `.shade.ts` path, no `..`, no leading
  slash, not the main file's), because `openLink` writes each one into the folder the user
  picked: a path that climbs out of it or plants `.vscode/tasks.json` is refused.
- **2**, the Canvas tab, this repository: `TypeShade: Show Canvas` (`typeshade.showCanvas`) opens
  the panel on a fifth tab that draws the active file's workspace each frame. The pin does not
  move for it: `7c274e2` already carries `typeshade/runtime` (0025) and the pass semantics of
  0026 that the tab implements. The extension host compiles (`canvas.ts`: `compile` and `packModule`, the
  fullscreen vertex half composed as the site does) and plans every binding
  (`canvas-plan.ts`), and a second esbuild bundle, `dist/webview/canvas.js`
  (`src/webview/canvas.ts`, browser IIFE, 52 KB, no compiler in it), loads what the host posts
  into the runtime. `docs/design.md` §4 describes it and §6 how it is tested.
  - **Passes: done, not deferred.** With a `typeshade.json` that names the active file, the
    passes are drawn in order into `rgba16float` textures the size of the canvas, two per pass
    swapped each frame, and the main file goes to the canvas. A `texture_2d<f32>` named like a
    pass reads this frame's output of an earlier pass and the previous frame's of itself or a
    later one, zeroes on the first frame. `separable-blur` (this frame's read) and
    `feedback-trail` (the previous frame's, through the frame counter) both draw.
  - **Uniforms:** `time`, `resolution`, `mouse`, `frame` and `timeDelta` are filled when the
    uniform struct declares them at those types and nowhere else; every other field is zero.
    A `texture_2d<f32>` that is no pass gets the site's checker, and a sampler is linear and
    clamped. A storage buffer, a comparison sampler, a storage texture, a texture of another
    kind, a program without exactly one `@vertex` and one `@fragment`, or a fragment with more
    than one colour output is refused with a sentence that names it.
  - **Backend: WebGPU only,** because the runtime is. Nothing is drawn on WebGL2 or the CPU
    oracle, and there is no control for a shader's own uniform fields and no dropped picture:
    the Playground has both, and they are the next steps if the tab is to match it.
  - **Measured in VS Code 1.139.1** (Electron on Linux, under `xvfb-run`): the webview has
    `navigator.gpu`. With `--disable-gpu`, which CI uses, `requestAdapter` returns nothing and
    the tab says so in one sentence. With `--enable-unsafe-webgpu --enable-unsafe-swiftshader
--use-angle=swiftshader --use-vulkan=swiftshader` instead of `--disable-gpu`, the same
    build's webview gets a software adapter and draws: the electron suite's Canvas case
    reads `drawing`, from the development path and from the packaged directory alike. Those
    flags are the runner's, not the extension's; a user's VS Code with a GPU needs none of them.
    The bundle alone was also run in Chromium on SwiftShader with the two multipass examples,
    which drew a trail and a blurred pattern.
