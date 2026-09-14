# TypeShade for editors

Editor support for [TypeShade](https://github.com/typeshade/typeshade), the TypeScript shader
language whose files start with the `"use typeshade"` directive and compile to WGSL and
GLSL ES 3.00.

This repository holds two packages:

| Package                                                    | What it is                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/tsserver-plugin`](./packages/tsserver-plugin)   | `@typeshade/tsserver-plugin`, a TypeScript server plugin. Every editor that runs tsserver (VS Code, Cursor, WebStorm, Neovim) gets TypeShade diagnostics, hover, completions, signature help, definitions, references and rename for `"use typeshade"` files, with no separate language server. |
| [`packages/vscode-typeshade`](./packages/vscode-typeshade) | The VS Code extension. It activates the plugin and adds what tsserver cannot carry: a WGSL and GLSL preview panel, commands, and a debug adapter for stepping a shader on the CPU.                                                                                                              |

## Status

Early. Nothing is published to npm or to the Visual Studio Marketplace yet, and the compiler
itself is not on npm either, so both packages are marked private while the interfaces settle.
The plan, the architecture and the decisions behind them are in
[`docs/design.md`](./docs/design.md).

| Piece                            | State                                                 |
| -------------------------------- | ----------------------------------------------------- |
| Workspace, CI, conventions       | done                                                  |
| Design document                  | done, [`docs/design.md`](./docs/design.md)            |
| TypeScript server plugin         | done, tested against a real tsserver                  |
| VS Code extension and preview    | done, tested in a real VS Code                        |
| Debug adapter (`typeshade` type) | after the compiler's stepping engine lands            |
| Marketplace publish workflow     | last, and it needs a publisher the owner creates once |

## Develop

The compiler is a pinned git submodule under `vendor/typeshade` until it publishes to npm
([`docs/design.md`](./docs/design.md) §2), and both artifacts bundle it, so a checkout without
it fails at the first import:

```bash
git clone --recurse-submodules https://github.com/typeshade/vscode-typeshade
# or, in an existing checkout
git submodule update --init

npm install
npm run check        # build, typecheck, lint, format, prose, tests
```

`npm run build` comes first in that list because the tsserver suite loads the built bundle: the
plugin is what tsserver `require`s, so a suite run against stale output would be testing
nothing.

Individually: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run test`.
`npm run format` rewrites instead of checking.
[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs the same steps on every push and
pull request.

`npm run test:electron` is separate, and separate on purpose. It launches a real VS Code with
the extension loaded and asserts what only a real host can answer, including that the server
plugin loaded at all. It downloads VS Code once (327 MB) and needs a display, so on a headless
machine run it as `xvfb-run -a npm run test:electron`; CI runs it as its own job for the same
reason, and a Marketplace publish must not wait on it.

## Conventions

The conventions are the compiler repository's, so that a reader moving between the two
repositories does not have to switch styles: JSDoc on every exported symbol, comments that
explain why rather than what, no em dashes, no `any`, prettier clean, and tests beside the code
they cover. `npm run check:prose` fails on an em dash in a tracked file, because a convention
nothing checks is a convention that drifts.

## License

MIT. See [`LICENSE`](./LICENSE).
