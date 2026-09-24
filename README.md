# TypeShade for editors

Editor and agent support for [TypeShade](https://github.com/typeshade/typeshade), the TypeScript
shader language whose files start with the `"use typeshade"` directive and compile to WGSL and
GLSL ES 3.00.

This repository holds three packages and a Claude Code plugin:

| Package                                                    | What it is                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`packages/tsserver-plugin`](./packages/tsserver-plugin)   | `@typeshade/tsserver-plugin`, a TypeScript server plugin. Every editor that runs tsserver (VS Code, Cursor, WebStorm, Neovim) gets TypeShade diagnostics, hover, completions, signature help, definitions, references and rename for `"use typeshade"` files, with no separate language server.                                                  |
| [`packages/vscode-typeshade`](./packages/vscode-typeshade) | The VS Code extension. It activates the plugin and adds what tsserver cannot carry: a WGSL and GLSL preview panel, commands, and a debug adapter for stepping a shader on the CPU.                                                                                                                                                               |
| [`packages/mcp-server`](./packages/mcp-server)             | `@typeshade/mcp`, a Model Context Protocol server. Coding agents (Claude Code, Codex, Cursor, VS Code agent mode, Gemini CLI) get the same diagnostics as the editor, the emitted WGSL and GLSL, types and navigation, the vocabulary, which corrects a name from another shading language (`lerp` → `mix`), and a CPU run of a shader function. |
| [`plugins/typeshade`](./plugins/typeshade)                 | A Claude Code plugin, installable from this repository as a marketplace: a skill that teaches the language, with every example compiled in CI, and the MCP server.                                                                                                                                                                               |

## Status

Early. `@typeshade/mcp` 0.1.1 is on npm, published by pushing its tag
([`docs/agents.md`](./docs/agents.md) §6). Nothing else is published yet, to npm or to the Visual
Studio Marketplace: the compiler itself is not on npm, so the other two packages stay private
while the interfaces settle. The plan, the architecture and the decisions behind them are in
[`docs/design.md`](./docs/design.md) for the editor and [`docs/agents.md`](./docs/agents.md) for
coding agents.

| Piece                            | State                                                 |
| -------------------------------- | ----------------------------------------------------- |
| Workspace, CI, conventions       | done                                                  |
| Design document                  | done, [`docs/design.md`](./docs/design.md)            |
| TypeScript server plugin         | done, tested against a real tsserver                  |
| MCP server (`@typeshade/mcp`)    | done, tested over stdio with the official MCP client  |
| MCP server publish workflow      | done; 0.1.1 published from the tag `mcp-v0.1.1`       |
| Skill and Claude Code plugin     | done; the server entry runs the npm package           |
| VS Code extension and preview    | done, tested in a real VS Code                        |
| Debug adapter (`typeshade` type) | after the compiler's stepping engine lands            |
| Marketplace publish workflow     | last, and it needs a publisher the owner creates once |

## Use with a coding agent

In Claude Code, the plugin brings the skill and the server together:

```text
/plugin marketplace add typeshade/vscode-typeshade
/plugin install typeshade@typeshade
```

Both work at once: the server entry runs `npx -y @typeshade/mcp`, so nothing needs building.
Codex, Cursor, Gemini CLI and VS Code start the same package, as
[`packages/mcp-server/README.md`](./packages/mcp-server/README.md) shows. The skill's directory,
[`plugins/typeshade/skills/typeshade`](./plugins/typeshade/skills/typeshade), is in the portable
Agent Skills format, so it can also be copied into Codex, Cursor or Gemini CLI as it is.

## Develop

The compiler is a pinned git submodule under `vendor/typeshade` until it publishes to npm
([`docs/design.md`](./docs/design.md) §2), and every artifact bundles it, so a checkout without
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
pull request. On a pull request it also runs the pinned compiler's
`scripts/downstream-impact.ts`, which fails while a file here still names an export or a file
that the new pin removes, while a compiler `LINT.ThenChange(//vscode-typeshade/...)` target has
not changed with its block, or while a compiler change proposal that the new pin implements
names this repository and [`compiler-changes.md`](./compiler-changes.md) does not record its
id. The compiler's `scripts/ifchange.ts` checks this repository's own `LINT.IfChange` pairs the
same way. In a Claude Code session, `scripts/commit-gate.mjs` runs the fast checks (prettier,
eslint, the em dash check) before every commit, so a convention costs a local retry rather than
a CI round trip.

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
