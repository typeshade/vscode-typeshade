# TypeShade for VS Code

Language support for [TypeShade](https://typeshade.dev), the TypeScript shader language whose
files start with the `"use typeshade"` directive and compile to WGSL and GLSL ES 3.00.

A `"use typeshade"` file is a TypeScript file, and this extension makes the editor answer for it
the way the compiler does: diagnostics, hover, completions, signature help, go to definition,
references and rename come from TypeShade's language service, through a TypeScript server plugin
the extension turns on. TypeScript's own false errors on a shader file go away. Every other
TypeScript file is left as it is.

## Commands

| Command                         | What it does                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------- |
| TypeShade: Show WGSL            | Opens the preview beside the editor, on the WGSL the active file compiles to |
| TypeShade: Show GLSL            | The same, on the GLSL ES 3.00 vertex and fragment shaders                    |
| TypeShade: Show Reflection      | The same, on the bind groups, entry points and uniforms                      |
| TypeShade: Show Canvas          | The same, drawing the shader instead of printing it (needs WebGPU)           |
| TypeShade: Run Entry on CPU     | Runs a function of the file on the CPU, with the arguments you type          |
| TypeShade: Copy Output          | Copies the text of the preview's open tab                                    |
| TypeShade: Open in Playground   | Opens the file, the files it imports and its passes in the site's Playground |
| TypeShade: Open Playground Link | Writes the workspace a Playground link carries to a folder, and opens it     |

The preview follows the active editor and recompiles as you type. A folder downloaded from the
Playground carries a `typeshade.json` that names its main file and its passes, and Open in
Playground reads it.

The Canvas tab draws the active file every frame the way the Playground does: a file with no
`@vertex` entry gets the fullscreen triangle, the passes of a `typeshade.json` that names the file
are drawn in order into textures the size of the canvas, and the main file is drawn last. A
uniform struct's `time`, `resolution` (pixels), `mouse` (0 to 1 from the bottom left), `frame`
and `timeDelta` fields are filled, and any other field is zero; a `texture_2d<f32>` that is not a
pass shows a checker. The Canvas uses WebGPU, so it draws only where VS Code's webview has an
adapter; where it has none the tab says so and draws nothing. A file that stops compiling keeps
the last frame on screen under a banner that says why.

## Settings

| Setting                         | Default | Meaning                                                      |
| ------------------------------- | ------- | ------------------------------------------------------------ |
| `typeshade.preview.autoUpdate`  | `true`  | Recompile the preview while you type                         |
| `typeshade.preview.debounceMs`  | `300`   | How long after the last keystroke the preview recompiles     |
| `typeshade.diagnostics.replace` | `true`  | Let the plugin replace TypeScript's answers on a shader file |
| `typeshade.debug.precision`     | `f32`   | The arithmetic Run Entry on CPU uses                         |
| `typeshade.trace.server`        | `off`   | Log the plugin's requests into the TypeScript server log     |

## VS Code for the Web

On vscode.dev and other VS Code for the Web pages the extension gives a `"use typeshade"` file
the language features and nothing else: diagnostics, TypeScript's false errors gone, hover, and
imports between shader files. They come from the same TypeScript server plugin as on the desktop.

Every command in the table above needs the desktop version. On the web each one shows a message
that says so and does nothing else: there is no preview, no Canvas, no Run Entry on CPU and no
Playground link. The settings below are not read on the web.

Two conditions apply:

- **VS Code for the Web 1.110 or newer.** An older one does not load the plugin at all, so
  TypeScript's own false errors stay on a shader file. The extension installs there anyway and
  shows a warning once.
- **A page that is cross-origin isolated.** Without it the TypeScript server does not run its
  semantic checks in the browser, so there are no TypeShade diagnostics and TypeScript shows none
  of its own either; the extension shows a warning once. vscode.dev was checked to be isolated when
  the web build was written, and the extension's own tests do not check that. A VS Code for the
  Web you host yourself needs the `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`
  headers.

Completion, signature help, references, rename and the outline use the same plugin methods on the
web, and are not covered by the extension's web tests. The web build was tested on VS Code for the
Web 1.139.1 and 1.110.0 in Chromium; other browsers were not tested.

## Requirements

VS Code 1.90 or newer on the desktop (see above for the web). A repository that pins its own `typescript` gets the plugin too: the
extension enables it for the workspace TypeScript version.

The status bar names the entry points of a shader file, and says so when TypeScript is still
reporting its own errors on one, which means the plugin did not load.

## Source

[github.com/typeshade/vscode-typeshade](https://github.com/typeshade/vscode-typeshade), under the
Apache License 2.0.
