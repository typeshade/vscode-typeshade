# Does a real tsserver load the plugin

`docs/design.md` §6 tests the plugin against a real `tsserver.js` driven over stdio rather than
against a hand-built `ts.LanguageService`, because the part most likely to break is the loading
and decoration contract, and only the real server exercises it. Two questions had to be
answered before the testing plan could rest on that.

1. Does tsserver find and run a plugin named with `--globalPlugins` and resolved from a
   `--pluginProbeLocations` directory, when the project's own `tsconfig.json` does not name it?
2. Can a test drive the protocol well enough to read diagnostics back, with no editor present?

[`probe.ts`](./probe.ts) answers both against the pass-through plugin of
`packages/tsserver-plugin`:

```bash
npm install
npm run build
bun docs/measurements/tsserver-plugin-load/probe.ts
bun docs/measurements/tsserver-plugin-load/probe.ts --allow-local
```

## The run the design document reports

2026-09-14, typescript 5.6.3, node 22.22.2 running the server.

```
tsserver     /home/user/vscode-typeshade/node_modules/typescript/lib/tsserver.js
flags        --globalPlugins --pluginProbeLocations
plugin       enabled=true create-ran=true
             Loading global plugin typeshade-tsserver-plugin
             Enabling plugin typeshade-tsserver-plugin from candidate paths: /home/user/vscode-typeshade,/home/user/vscode-typeshade/node_modules/typescript/lib/typescript.js/../../..
             Loading typeshade-tsserver-plugin from /home/user/vscode-typeshade (resolved to /home/user/vscode-typeshade/node_modules)
             Info 17   [16:15:40.250] [typeshade] plugin loaded (typescript 5.6.3)
shader.shade.ts    semanticDiag    4 TS1206 TS2304 TS2349
shader.shade.ts    syntaxDiag      0
shader.shade.ts    suggestionDiag  0
host.ts            semanticDiag    0
host.ts            syntaxDiag      0
host.ts            suggestionDiag  0
quickinfo    vec4 call site reads as "any"
```

The run with `--allowLocalPluginLoads` is identical, line for line.

## What the run establishes

| Claim the design makes                                                           | What the run shows                                                                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| A plugin can be loaded without touching the project's `tsconfig.json`            | `--globalPlugins` plus `--pluginProbeLocations` is enough, and `create` runs                                                         |
| `--allowLocalPluginLoads` is not needed when the probe location holds the plugin | Both runs are identical; that flag governs loading a plugin named by a project's own config, which is not how the extension loads it |
| npm workspaces already produce the layout tsserver resolves against              | The plugin resolved through `node_modules/typeshade-tsserver-plugin`, which the workspace links to `packages/tsserver-plugin`        |
| A protocol test can read diagnostics back per file and per kind                  | Three `*Diag` events arrived for each of the two files                                                                               |
| Grammar errors such as TS1206 arrive as semantic, not syntactic                  | `semanticDiag` carries TS1206 and `syntaxDiag` is empty, which is why §3 can pass the syntactic pass through untouched               |
| An unhelped editor has nothing useful to say about a shader file                 | Four false errors on nine lines, and `vec4(...)` reads as `any`                                                                      |

## What is not established

That the plugin can be loaded the way VS Code loads it, through
`contributes.typescriptServerPlugins`, which passes the extension's own directory as the probe
location. That path needs a running VS Code and belongs to the extension tests of §6.
