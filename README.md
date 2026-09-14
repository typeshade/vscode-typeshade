# TypeShade for editors

Editor support for [TypeShade](https://github.com/typeshade/typeshade), the TypeScript shader
language whose files start with the `"use typeshade"` directive and compile to WGSL and
GLSL ES 3.00.

This repository holds two packages:

| Package                                                    | What it is                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/tsserver-plugin`](./packages/tsserver-plugin)   | `typeshade-tsserver-plugin`, a TypeScript server plugin. Every editor that runs tsserver (VS Code, Cursor, WebStorm, Neovim) gets TypeShade diagnostics, hover, completions, signature help, definitions, references and rename for `"use typeshade"` files, with no separate language server. |
| [`packages/vscode-typeshade`](./packages/vscode-typeshade) | The VS Code extension. It activates the plugin and adds what tsserver cannot carry: a WGSL and GLSL preview panel, commands, and a debug adapter for stepping a shader on the CPU.                                                                                                             |

## Status

Early. Nothing is published to npm or to the Visual Studio Marketplace yet, and the compiler
itself is not on npm either, so both packages are marked private while the interfaces settle.
The plan, the architecture and the decisions behind them are in
[`docs/design.md`](./docs/design.md).

| Piece                            | State                                                 |
| -------------------------------- | ----------------------------------------------------- |
| Workspace, CI, conventions       | this commit                                           |
| Design document                  | next                                                  |
| TypeScript server plugin         | after the design document                             |
| VS Code extension and preview    | after the plugin                                      |
| Debug adapter (`typeshade` type) | after the compiler's stepping engine lands            |
| Marketplace publish workflow     | last, and it needs a publisher the owner creates once |

## Develop

```bash
npm install
npm run check        # typecheck, lint, format, prose, tests
```

Individually: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run test`.
`npm run format` rewrites instead of checking.
[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs the same steps on every push and
pull request.

## Conventions

The conventions are the compiler repository's, so that a reader moving between the two
repositories does not have to switch styles: JSDoc on every exported symbol, comments that
explain why rather than what, no em dashes, no `any`, prettier clean, and tests beside the code
they cover. `npm run check:prose` fails on an em dash in a tracked file, because a convention
nothing checks is a convention that drifts.

## License

MIT. See [`LICENSE`](./LICENSE).
