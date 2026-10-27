# Extension 0.3.0 release verification

Measured on 2026-10-27 UTC. This records the release checks from `docs/design.md` §7.
The checks cover packaging, distribution and the published web extension. They measure no GPU performance.

## Configuration

| Item           | Value                                                                 |
| -------------- | --------------------------------------------------------------------- |
| Extension      | `typeshade.vscode-typeshade` 0.3.0                                    |
| Release tag    | `extension-v0.3.0`                                                    |
| Release commit | `10a99ec7b129ae2c545534323634c7b2b83c96d5`                            |
| Compiler pin   | `3e1e8420a5313e045beb175131148920bfdc2d07`                            |
| Live host      | vscode.dev 1.143.1, commit `e646868227c3e3a9e3f24277c8c7220be42c0be7` |
| Browser        | Headless Chromium 153.0.8010.12 on Linux                              |
| Page isolation | `crossOriginIsolated: true`, `SharedArrayBuffer: function`            |

The release commit has the same tree as PR #65's tested head, `76eb2a410449f8bb645977bb66cc55a35baddfa6`.
Local `npm run check` passed 406 tests across 25 files.

## Release gates

All three web host configurations passed three times before tagging: VS Code 1.139.1 isolated,
1.139.1 without isolation, and 1.110.0 isolated. The desktop suite passed in each run.

- [PR CI](https://github.com/typeshade/vscode-typeshade/actions/runs/40454878566).
- [Repeated CI](https://github.com/typeshade/vscode-typeshade/actions/runs/40454880250).
- [Publication dry run](https://github.com/typeshade/vscode-typeshade/actions/runs/40455033848), including packaging and the packaged desktop suite. Its publish job was skipped.
- [Tagged publication](https://github.com/typeshade/vscode-typeshade/actions/runs/40455617682) repeated verification and packaged tests, then published to both registries.

## Published bytes

The [GitHub release](https://github.com/typeshade/vscode-typeshade/releases/tag/extension-v0.3.0)
was published at 05:32:41 UTC. Its VSIX and downloads from the Marketplace and Open VSX
have the same 5,672,443 bytes and SHA-256:

```text
95a90acbd881af1c327a582ea2ccba0503ca6e26e7c49df2bfbea122632715ad
```

Each archive's manifest reports version 0.3.0. The Marketplace response used gzip transport
encoding; the hash above is of the decoded VSIX. Search metadata initially still listed 0.2.1.
Both public catalogs listed 0.3.0 by 05:40 UTC.

The web plugin was fetched from:

```text
https://typeshade.vscode-unpkg.net/TypeShade/vscode-typeshade/0.3.0/extension/node_modules/@typeshade/tsserver-plugin/index.web.js
```

Its decoded 4,766,648 bytes match the plugin inside the published VSIX, with SHA-256:

```text
f636e1f03ac2f3f87f5894c72a6e758cfb783637785a214dafdf2cd0c236c1f8
```

A request with `Origin: https://vscode.dev` received HTTP 200 and these headers:

```text
content-type: application/javascript
content-encoding: br
cross-origin-resource-policy: cross-origin
access-control-allow-origin: https://vscode.dev
access-control-allow-headers: *
vary: Origin
```

## Live web host

Two fresh browser contexts exercised the published files. The first used
`Developer: Install Extension from Location...` with the public 0.3.0 CDN directory while
search metadata propagated. The second used the ordinary Marketplace Install button after
its details page showed 0.3.0, then `Trust Publisher & Install`. The installed page showed
version 0.3.0 with Disable and Uninstall controls.

Each context opened a folder containing these two files. The browser's origin-private file
system supplied the folder through `showDirectoryPicker`, as in the earlier vscode.dev check.
This exercises a folder workspace, not a GitHub virtual workspace.

`clean.shade.ts`:

```ts
"use typeshade";
class Slot {
  value: f32 | null | undefined;
  constructor(value: f32 | null | undefined) { this.value = value; }
}
function gain(value: f32 | null | undefined): f32 { return value ?? 1.; }
@fragment export function fs(): f32 { return gain(new Slot(null).value); }
```

`broken.shade.ts`:

```ts
"use typeshade";
function gain(value: f32 | null | undefined): f32 { return value * 2.; }
@fragment export function fs(): f32 { return gain(null) + nope(1.); }
```

Observed in both contexts:

- The clean file added no diagnostic. The Problems panel retained only the broken file's two errors.
- The broken file reported `typeshade(8003)` on the nullable multiplication and `typeshade(8004)` on `nope`.
- TypeScript's five original errors disappeared. No duplicate TypeScript diagnostic remained.
- The member hover was `(property) Slot.value: f32 | null | undefined`.

The Marketplace installation also returned `function gain(value: f32 | null | undefined): f32`
on the function hover. In the first context, `TypeShade: Open Playground Link` showed the
expected desktop-only notice and opened no page.

Opening `github.dev/typeshade/typeshade` redirected to vscode.dev and requested GitHub sign-in.
No account was signed in. Virtual-workspace shader behavior and the need for
`capabilities.virtualWorkspaces` remain unmeasured; this release changes neither declaration.
