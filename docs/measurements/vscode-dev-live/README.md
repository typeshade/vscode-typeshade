# The published extension on vscode.dev

The manual check `docs/design.md` §7 asks for after a release, run on 0.2.0.

Date: 2026-09-29. The real https://vscode.dev in headless Chromium 141.0.7390.37, driven by
Playwright 1.63.0 over the DevTools protocol with a fresh profile. vscode.dev served the web build
`stable/04c0d99f4fb0d8afe6ce4f0c58e31e183ac3e4b1` (VS Code for the Web 1.139.1, the build the web
suite pins), with its own page commit `3ebf7aeee6510441d39ec4b69f277994c3e6b389` in `x-commit`. The
extension came from the Marketplace: `typeshade.vscode-typeshade` 0.2.0. No account was signed in.

## Result

On the real vscode.dev the 0.2.0 web build installs from the Extensions view, loads its plugin
into both TypeScript web servers, removes TypeScript's false errors on a shader file, reports the
TypeShade errors (source `typeshade`, codes 8003 and 8004) and answers hover from the compiler. The
page, the extension host frame, the extension host worker and both TypeScript server workers are
cross-origin isolated. The plugin file is served as `application/javascript`, Brotli-compressed,
with CORP `cross-origin`. Three things the design did not say came out of the run; they are under
"Findings".

The run went through the HTTPS proxy of the machine it ran on, with certificate checking on, and
logged every response of the browser context with its headers. The logs and screenshots stayed on
that machine; this file quotes what they showed.

## Step 1: cross-origin isolation

`self.crossOriginIsolated` and `typeof SharedArrayBuffer`, read in each context:

| Context                                                                                  | crossOriginIsolated | SharedArrayBuffer |
| ---------------------------------------------------------------------------------------- | ------------------- | ----------------- |
| the page, at `https://vscode.dev/` and at `/github/typeshade/typeshade`                  | true                | function          |
| both extension host iframes (`webWorkerExtensionHostIframe.html` on `vscode-cdn.net`)    | true                | function          |
| the `ExtensionHostWorker` worker                                                         | true                | function          |
| the TypeScript syntax server and semantic server workers, under the extension host       | true                | function          |
| `editorWorkerService`, `LanguageDetectionWorker`, `TextMateWorker` (blobs on vscode.dev) | true                | function          |

The page's response headers say why: `cross-origin-opener-policy: same-origin` and
`cross-origin-embedder-policy: require-corp`. So `docs/design.md` §3.1's first condition holds on
vscode.dev, in the page and in every worker the plugin depends on. github.dev and
insiders.vscode.dev were not measured.

## Step 2: a workspace with a `"use typeshade"` file

- `https://vscode.dev/github/typeshade/typeshade` opens the explorer for `typeshade [GitHub]`, then
  a modal "The extension 'GitHub Repositories' wants to sign in using GitHub", and the explorer
  stays empty. The sign-in was not accepted, so a GitHub repository, even a public one, was not
  opened.
- An untitled file with the language set to TypeScript, the shader pasted into it. Used for the
  baseline before the install, and again after it (finding 1).
- A folder workspace without a sign-in. vscode.dev's "Open Folder" calls `showDirectoryPicker`,
  which needs a user gesture a headless run cannot give, so that one function was replaced by one
  that returns a directory of the browser's origin-private file system, holding `broken.shade.ts`
  and `clean.shade.ts`. The Explorer's "Open Folder" then opened it as an ordinary folder
  workspace (scheme `file`, tsserver path `/file/ts-nul-authority/ws/broken.shade.ts`), after the
  workspace trust prompt. This stands in for a folder a user picks; it is not something a user
  does.

The shader is the `CLEAN` fixture of `packages/tsserver-plugin/src/fixtures.ts` plus two errors,
`vec3(...) + vec2(...)` on line 13 and `nope(1.)` on line 14. `clean.shade.ts` is `CLEAN` itself.

For anyone repeating this: `F1` on vscode.dev already types `>`, and "File: New Untitled Text File"
can fuzzy-match "Compare New Untitled Text Files"; Ctrl+N opens an untitled file reliably.

## Step 3: install

- Extensions view, search `typeshade.vscode-typeshade`: one result, "TypeShade", publisher "Type
  Shade", version 0.2.0, with an Install button. vscode.dev offers it as a web extension.
- Install asks "Do you trust the publisher 'Type Shade'?" (an unverified publisher, the first
  extension from it). "Trust Publisher & Install" installs it within seconds, with no reload. The
  details page shows 0.2.0 with Disable and Uninstall, and an activation time of 7 ms.
- The extension host log shows the activation on `onLanguage:typescript`; the TypeScript log shows
  the TypeScript extension restarting its servers on its own when the extension appears.
- No warning appeared after activation, as expected on an isolated, current page.
- The extension has no output channel of its own on the web.

## Step 4: diagnostics, hover, a desktop-only command

Before the install, the shader had 9 problems, all from `ts` and all false: TS2349 "This expression
is not callable. Type 'Location' has no call signatures." on `@location(0)`, TS2304 "Cannot find
name" for `vec4` (3), `f32` (2), `vec3`, `vec2` and `nope`, and TS1206 "Decorators are not valid
here." on `@fragment`.

After the install, in `broken.shade.ts`, polled every 5 s, the Problems view had at the first poll
exactly:

```
broken.shade.ts 2
Type mismatch: cannot + vec3 and vec2. Vectors must have the same size.   typeshade(8003) [Ln 13, Col 13]
Unknown function "nope". Declare it in this file, or import it from another shader module.  typeshade(8004) [Ln 14, Col 13]
```

No TS1206, TS2304 or TS2349; squiggles under `vec3(...) + vec2(...)` and `nope` only. The verbose
tsserver log (`typescript.tsserver.log: verbose`) has the same two as `semanticDiag` events with
`"source":"typeshade"`. `clean.shade.ts`, open beside it, had no problems and `semanticDiag` `[]`.

Hover:

- `vec4` in `@location(0) color: vec4`: "vec4 - A four-component vector of f32."
- `f32` as a parameter type: "f32 - 32-bit floating-point value."
- `tint`, at the call and at the declaration: "function tint(x: f32): f32"
- the same `vec4` answer in `clean.shade.ts`.

The TypeScript server log has, for each of the syntax and semantic servers, `Dynamically importing
@typeshade/tsserver-plugin from https://typeshade.vscode-unpkg.net/TypeShade/vscode-typeshade/0.2.0/extension`,
then `[typeshade] plugin loaded (typescript 6.0.3)`, `[typeshade] language service decorated` and
`Plugin validation succeeded`.

A desktop-only command: "TypeShade: Show WGSL" is not in the Command Palette on the web (finding
3). "TypeShade: Open Playground Link", which has no `when`, is, and `typeshade.showWgsl` was run
through a user key binding. Both showed the same notification, and nothing else opened:

> TypeShade on the web gives diagnostics, hover and imports between shader files in "use typeshade" files. The preview, the Canvas, Run Entry on CPU and the Playground link need the desktop version.

That is `WEB_STUB_MESSAGE` in `web-support.ts`. The other six commands were not run.

## Step 5: the web plugin file's response headers

vscode.dev requests
`https://typeshade.vscode-unpkg.net/TypeShade/vscode-typeshade/0.2.0/extension/node_modules/@typeshade/tsserver-plugin/index.web.js`
twice, from the two tsserver workers. The publisher segment is `TypeShade`, mixed case; `typeshade`
answers too.

| Header                       | Value                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| status                       | 200                                                                                                    |
| content-type                 | `application/javascript`                                                                               |
| content-encoding             | `br`, chunked, no `content-length`                                                                     |
| access-control-allow-origin  | `*` for the worker's request; `https://vscode.dev` when the request sends `Origin: https://vscode.dev` |
| access-control-allow-headers | `*`                                                                                                    |
| cross-origin-resource-policy | `cross-origin`                                                                                         |
| cache-control                | `max-age=31536000`                                                                                     |
| x-content-type-options       | `nosniff`                                                                                              |

The same URL fetched outside the browser: 4,601,293 bytes uncompressed (4.39 MiB), 1,184,289 bytes
under Brotli, and gzip is served too. So the 4.4 MiB bundle is compressed for a client that asks,
which answers §7's open question about the threshold for this file. The extension's
`dist/web/extension.js` and the plugin's `package.json` carry the same CORS and CORP headers.

## Findings

1. **An untitled file got no diagnostics.** An untitled TypeScript editor starting with
   `"use typeshade"` (`/untitled/ts-nul-authority/Untitled-2` in tsserver) showed no problem for
   60 s, although it had both errors. Its `semanticDiag` events were `[]`: the plugin took the file
   over, so TypeScript's errors were gone, and reported nothing. The cause: the name has no
   extension, and the TypeShade service's own TypeScript program leaves out a root file whose name
   is not a TypeScript one, so the service answered `[]` for it. The same holds on the desktop,
   where the name is `^/untitled/...`. Fixed after 0.2.0 by holding such a file in the service
   under an alias (`packages/tsserver-plugin/src/program-names.ts`), with a real tsserver test of
   both names.
2. **A shader shows TypeScript's false errors until the plugin loads.** In the semantic server's
   log, the first `semanticDiag` events for both files carry TS2349, TS2304 and TS1206 and come
   before `[typeshade] plugin loaded`; the next ones carry 8003 and 8004, and `[]`. The Problems
   view showed only the TypeShade diagnostics at the first 5 s poll, so the window is shorter than
   that; it was not measured more finely.
3. **The palette hides the preview commands on the web.** Seven commands are shown only when
   `typeshade.isShader` is set, and only the desktop entry sets it. So on the web the stub message
   is reached through "Open Playground Link" or a key binding, not through "TypeShade: Show WGSL".

## Not done

- github.dev, insiders.vscode.dev, a signed-in repository, virtual workspaces (`vscode-vfs`) and
  whether `capabilities.virtualWorkspaces` is needed (§7 step 3).
- A plain `.ts` file with the extension installed, completion, signature help, references, rename,
  and an import between two shader files.
- The stub's isolation and version warnings: never shown here, since the page is isolated and
  current.
