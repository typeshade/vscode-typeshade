# Changelog

## 0.1.0

The first release, over the compiler `typeshade` 0.0.1 at `88ba8ad`.

- A TypeScript server plugin gives `"use typeshade"` files TypeShade's diagnostics, hover,
  completions, signature help, definitions, references and rename.
- A preview panel shows the WGSL, the GLSL ES 3.00 and the reflection of the active file.
- Run Entry on CPU runs an entry point of the file on the compiler's CPU oracle.
- Open in Playground and Open Playground Link move a workspace between the file's folder and the
  site's Playground, passes included.
- A link is data from a stranger, since the `vscode://` handler takes it from any web page: only a
  short link on `https://typeshade.dev` is fetched, and only to read where it redirects. Any
  other link is read from its own fragment and never fetched, and a redirect that does not lead
  back to `https://typeshade.dev` is refused.
