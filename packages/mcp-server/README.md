# @typeshade/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives coding agents
(Claude Code, Codex, Cursor, VS Code agent mode, Gemini CLI) TypeShade's own answers about
`"use typeshade"` shader files: the diagnostics the editor shows, the WGSL and GLSL the compiler
emits, types and navigation, the vocabulary, and a run of a shader function on the CPU.

It is a third adapter over the compiler's `TypeshadeLanguageService`, beside the tsserver plugin
and the VS Code extension, so an agent and a person looking at the same file see the same
errors. The design and the decisions are in [`docs/agents.md`](../../docs/agents.md).

## Tools

| Tool         | What it answers                                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`      | The errors and warnings in a shader, a list of them, or every shader under a directory, plus anything the WGSL or GLSL emitter refuses. Also takes source text. |
| `compile`    | The emitted WGSL, the GLSL ES 3.00 vertex and fragment programs, the reflection (bind groups, uniform layouts, entry points) or the determinism report.         |
| `hover`      | The compiler's type for the name at a position, and its documentation.                                                                                          |
| `definition` | Where the name at a position is declared.                                                                                                                       |
| `references` | Every use of the name at a position, across the workspace's shaders.                                                                                            |
| `outline`    | A shader's structs, resources with their `@group` and `@binding`, functions and entry points.                                                                   |
| `docs`       | A type, builtin, attribute or `@builtin` id with every overload signature; a GLSL or HLSL name is translated (`lerp` is `mix`).                                 |
| `run`        | One function run on the CPU at f32, with arguments, builtin inputs and uniform values, optionally stopping at lines to report every local.                      |

Every tool only reads. Positions are one-based lines, with either a column or the symbol's own
text (`{ "line": 13, "symbol": "tint" }`). The ambient declarations are also served as the
resource `typeshade://ambient/shade.d.ts`.

## Install

The package is not on npm yet (`docs/agents.md` §6). Until it is, build it from this
repository and point the client at the bundle:

```bash
git clone --recurse-submodules https://github.com/typeshade/vscode-typeshade
cd vscode-typeshade && npm install && npm run build
# the server is now packages/mcp-server/dist/index.js
```

The snippets below use `npx -y @typeshade/mcp`, which is what they will say once it is
published; with a local build, use `node /path/to/vscode-typeshade/packages/mcp-server/dist/index.js`
as the command instead.

**Claude Code.** The plugin in this repository installs the server together with the TypeShade
skill:

```text
/plugin marketplace add typeshade/vscode-typeshade
/plugin install typeshade@typeshade
```

Or the server alone, for this project (`--scope user` for every project):

```bash
claude mcp add typeshade -- npx -y @typeshade/mcp
```

**Codex CLI**, in `~/.codex/config.toml`:

```toml
[mcp_servers.typeshade]
command = "npx"
args = ["-y", "@typeshade/mcp"]
```

**Cursor** (`.cursor/mcp.json`) and **Gemini CLI** (`.gemini/settings.json`):

```json
{ "mcpServers": { "typeshade": { "command": "npx", "args": ["-y", "@typeshade/mcp"] } } }
```

**VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "typeshade": { "type": "stdio", "command": "npx", "args": ["-y", "@typeshade/mcp"] }
  }
}
```

## Which files it reads

Only files under its roots, after following symbolic links. The roots are, in order of
preference: the directories given with `--root <dir>` (repeatable); the workspace folders the
client reports through MCP roots; the directory the client started the server in. A client that
starts servers somewhere else and reports no roots needs `--root`, for example
`"args": ["-y", "@typeshade/mcp", "--root", "${workspaceFolder}"]` in VS Code.

## Develop

`npm run build` at the repository root builds this package with the other two, and
`npm run test` runs its suites: `tools.test.ts` calls every tool on shaders written to a
temporary directory, and `server.test.ts` starts the built bundle and speaks to it over stdio
with the official MCP client, so it needs the build first, as the plugin's suite does.
