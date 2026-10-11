# Changelog

## Unreleased

### Added

- An inlay hint `&` before each argument that an `@inout` or `@out` parameter takes, the
  compiler's parameter qualifiers (its change 0040). The call passes the variable unmarked, and
  the hint shows that the function may change it. The hint covers a function of the same file,
  called by its name or through its namespaces. VS Code shows it only where it shows inlay hints.

### Changed

- The compiler is `typeshade` at `45ec661`. A hover on a qualified parameter shows its qualifier,
  and a read of a variable before it is assigned is the compiler's `TS8075`, where TypeScript
  reported TS2454.

### Fixed

- The preview panel shows an untitled editor that starts with `"use typeshade"`. Its WGSL and
  GLSL tabs were empty: the panel runs its own copy of the compiler's service, which left the
  untitled name out of its program, as the plugin's copy did before 0.2.1.
- The Reflection tab lists a program's overrides, and Run Entry on CPU runs an entry that reads
  an override or a module-scope `var` (a `workgroup` or a `private` one). The panel built the
  module it reflects and runs with four of the compiler's eight fields, and showed a static-only
  class, a namespace of functions, as an empty struct.

## 0.2.1

A fix over 0.2.0, with the same compiler (`typeshade` 0.0.1 at `7c274e2`).

### Fixed

- An untitled editor that starts with `"use typeshade"` now gets TypeShade's diagnostics and
  hover, on the desktop and on the web. Before, TypeScript's false errors went away and nothing
  took their place: an untitled editor's name has no extension, and the compiler's service left a
  file with such a name out of its program.

## 0.2.0

The first release that runs in VS Code for the Web, over the same compiler as 0.1.0: `typeshade`
0.0.1 at `7c274e2`. On the desktop nothing changes.

### Added

- Web support for the language features. On VS Code for the Web (vscode.dev and other pages) the
  TypeScript server plugin gives `"use typeshade"` files TypeShade's diagnostics, hover and
  imports between shader files, and TypeScript's false errors on them go away. Completion,
  signature help, references, rename and the outline use the same plugin methods and are not
  covered by a browser test.
- A web entry for the extension (`browser` in the manifest), a small stub, and a second plugin
  bundle for the browser.

### Notes

- The web build needs VS Code for the Web 1.110 or newer and a cross-origin isolated page. On an
  older VS Code the plugin is not loaded, and on a page that is not isolated the TypeScript server
  reports no semantic errors at all, so neither TypeScript nor TypeShade shows one. The extension
  says which once, when it activates.
- On the web every command of the extension shows a message and does nothing else: the preview, the
  Canvas, Run Entry on CPU, Copy Output, Open in Playground and Open Playground Link need the
  desktop version. The extension's settings are not read on the web.
- Tested on VS Code for the Web 1.139.1 and 1.110.0 in Chromium. Other browsers, other VS Code
  builds and a real installed copy on vscode.dev were not tested at the time of writing.
- The package grows from about 4.1 MB to 5.4 MB, which is the web plugin bundle (4.6 MB, about
  1.3 MB compressed). The desktop extension bundle is byte for byte what it was, and the
  desktop plugin bundle grew by 673 bytes for the split that lets both entries share one factory.

## 0.1.0

The first release, over the compiler `typeshade` 0.0.1 at `7c274e2`.

- A TypeScript server plugin gives `"use typeshade"` files TypeShade's diagnostics, hover,
  completions, signature help, definitions, references and rename.
- A preview panel shows the WGSL, the GLSL ES 3.00 and the reflection of the active file.
- A Canvas tab in the preview panel draws the active shader with the compiler's program runtime:
  the passes of a `typeshade.json` in order and then the main file, each frame, with `time`,
  `resolution`, `mouse`, `frame` and `timeDelta` filled where the uniform struct declares them
  and a checker on a texture that is no pass. It needs WebGPU in the webview; where there is
  none it says so and draws nothing. `TypeShade: Show Canvas` opens it.
- Run Entry on CPU runs an entry point of the file on the compiler's CPU oracle.
- Open in Playground and Open Playground Link move a workspace between the file's folder and the
  site's Playground, passes included.
- A link is data from a stranger, since the `vscode://` handler takes it from any web page: only a
  short link on `https://typeshade.dev` is fetched, and only to read where it redirects. Any
  other link is read from its own fragment and never fetched, and a redirect that does not lead
  back to `https://typeshade.dev` is refused. A link's files must be `.shade.ts` paths at or below
  the workspace folder, so a link cannot write outside the folder the user picked.
