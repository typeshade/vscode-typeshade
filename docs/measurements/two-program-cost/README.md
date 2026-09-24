# What a second TypeScript program costs

`docs/design.md` §1 chooses a TypeScript server plugin over a standalone language server, and
the choice turns on one number. A `"use typeshade"` file has to be type-checked by a program
built with `lib: []` and the ambient `SHADE_DTS` (`src/language-service/host.ts`,
`typeshadeCompilerOptions`), while tsserver's own project has the standard library. So the
plugin runs a `TypeshadeLanguageService` of its own beside the project's, and the question is
what that second program costs.

## How it is measured, and why the method is itself a finding

[`measure.ts`](./measure.ts) is a driver. It writes the fixture, bundles the compiler's
`./language-service` subpath with esbuild the way the plugin will ship it, then spawns
[`harness.mjs`](./harness.mjs) under `node --expose-gc`, three times per mode, each in a process
that does nothing else.

The first version of this measurement did none of that, and its numbers did not reproduce. Four
things were wrong, and they are worth naming because each one flatters the result:

1. **Both halves ran in one process**, so the heap figure was the difference of two
   whole-process readings taken while an unrelated 85 MB program sat in the same heap. Re-run
   three times, that method reported deltas of 5.1, 13.1 and 40.3 MB for what it published as
   4.4 MB. In an isolated process the same quantity reads 5.1 MB in every run, to the tenth.
2. **The compiler's module load sat outside the timed region**, so the cold number omitted work
   tsserver pays synchronously while a project loads.
3. **It ran under bun**, whose `process.version` reports a node version string, so the output
   named "node v24.3.0" for a run node never performed. tsserver runs under node.
4. **The phases were added together**, though they are paid at different times: requiring the
   plugin's code happens once per tsserver process, building the program once per project, and
   answering once per keystroke.

One more correction came out of the rewrite, and PR 3 reversed it. The bundle then left
`typescript` external, and since tsserver has `typescript` loaded before it asks for any plugin,
the harness loaded it before taking its baseline. PR 3 found that external was not reachable
(below), so the bundle now carries `typescript` and the harness charges the plugin for it.

```bash
npm install   # the workspace's own typescript and esbuild
git clone https://github.com/typeshade/typeshade vendor/typeshade
bun docs/measurements/two-program-cost/measure.ts
SHADE_COPIES=10 bun docs/measurements/two-program-cost/measure.ts
RUNS=5 bun docs/measurements/two-program-cost/measure.ts
SHADE_LIMIT=1 bun docs/measurements/two-program-cost/measure.ts
```

`SHADE_LIMIT` caps how many shader files the plugin mode opens, which is how the one-document
case `docs/design.md` §4 needs for the extension's preview panel is measured with this same
harness: at `7f0b482`, 243.3 to 294.3 ms and 45 MB to require the bundle, then 109 to 164.3 ms
and 7.3 MB to build and compile one document, 52.3 MB retained.

`vendor/typeshade` is where the pinned submodule lands when the plugin is implemented
(`docs/design.md` §2); until it exists a plain clone there does the same job, and
`TYPESHADE_COMPILER=/path/to/typeshade` overrides the location. The checkout has to sit inside
the workspace so node's upward resolution finds the workspace's pinned `typescript`: with a
sibling checkout in this container, `typescript` resolved to a global 7.0.2 install and the
compiler's sources failed at module evaluation with `ts.SyntaxKind` undefined. The bundle is
written under `node_modules/.cache/typeshade` for the same reason, one level further out.

The fixture is 150 plain TypeScript modules with real edges between them (interfaces, a class
holding a `Map`, an `async` function, and imports of two siblings each) plus the compiler's own
six `.shade.ts` examples, under a `tsconfig.json` with `lib: ["ES2022", "DOM"]`.

## The runs the design document reports

2026-09-24, in a session's container: node v22.22.2 doing the measuring, bun 1.3.11 driving,
typescript 5.6.3, compiler at `7f0b482`, the bundle as it ships, `typescript` inlined.

```
driver: bun 1.3.11, measuring under node
fixture: 150 .ts files, 6 .shade.ts files
compiler: /home/user/vscode-typeshade/vendor/typeshade
bundle: 10842 KB (esbuild, cjs, node20, typescript inlined)
runs: 3 per mode, each in its own process

## the editor today, no plugin (node v22.22.2)
cold, whole project        986.1 to 1345 ms (1345, 986.1, 1042)
warm, one shader edit      11.8 to 16.3 ms (16.3, 15.2, 11.8)
heap for the project       63.9 MB (63.9, 63.9, 63.9)
false errors on shaders    58 (58, 58, 58)
                           compute-reduction-twin.shade.ts: 12 (TS1206 TS2304 TS2552)
                           hello-camera.shade.ts: 4 (TS2304)
                           hello-uniform.shade.ts: 5 (TS1206 TS2304)
                           hello-vsin.shade.ts: 14 (TS1206 TS2304 TS2349)
                           hello-vsout.shade.ts: 13 (TS1206 TS2304 TS2349)
                           hello.shade.ts: 10 (TS1206 TS2304 TS2349)

## what the plugin adds (node v22.22.2)
require the bundle         240.5 to 277.1 ms (241.7, 240.5, 277.1)
  heap it retains          45 MB (45, 45, 45)
build and answer for all   206.5 to 215.2 ms (215.2, 206.5, 211.1)
  heap it retains          9.8 MB (9.8, 9.8, 9.8)
retained, both phases      54.8 MB (54.8, 54.8, 54.8)
warm, one shader edit      9.1 to 10.6 ms (9.1, 9.8, 10.6)
diagnostics on shaders     0 (0, 0, 0)
```

The same fixture with 60 shader files (`SHADE_COPIES=10`): no plugin, 1033.3 to 1082.7 ms cold,
66 MB, 12.1 to 14.2 ms per keystroke and 580 false errors; the plugin, 236.5 to 292.1 ms and
45 MB to require the bundle, 400 to 516.6 ms and 15.1 MB to build and answer, 60.1 MB retained,
8.4 to 9.1 ms per keystroke and 0 diagnostics on shaders.

Requiring `typescript` 5.6.3 alone, in a process of its own under `--expose-gc` and after a
collection, retains 15.5 MB in every run; that is the part of the require phase the bundled copy
accounts for.

## The runs at `a2240e0`, PR 3's

2026-09-14, in the session's container: 4 cores, node v22.22.2 doing the measuring, bun 1.3.11
driving, typescript 5.6.3, compiler at `a2240e0`, bundle 9.7 MB (10,219,538 bytes).

**These numbers are PR 3's, and they replace PR 2's.** The bundle used to leave `typescript`
external, which made it 470 KB (481,235 bytes) and made the require phase a third of what it
now is. A real VS Code showed that external was not reachable: node resolves it by walking up
from wherever the bundle sits, which is a different copy in a checkout and nothing at all in a
packaged extension. The measurement now bundles `typescript` the way the plugin ships it, so
the require phase is the whole cost rather than a third of it. `docs/design.md` §2 has the
failure that forced the change.

```
## the editor today, no plugin (node v22.22.2)
cold, whole project        1235 to 1299.9 ms (1299.9, 1243.3, 1235)
warm, one shader edit      18.2 to 18.8 ms (18.8, 18.2, 18.4)
heap for the project       63.9 MB (63.9, 63.9, 63.9)
false errors on shaders    58 (58, 58, 58)
                           compute-reduction-twin.shade.ts: 12 (TS1206 TS2304 TS2552)
                           hello-camera.shade.ts: 4 (TS2304)
                           hello-uniform.shade.ts: 5 (TS1206 TS2304)
                           hello-vsin.shade.ts: 14 (TS1206 TS2304 TS2349)
                           hello-vsout.shade.ts: 13 (TS1206 TS2304 TS2349)
                           hello.shade.ts: 10 (TS1206 TS2304 TS2349)

## what the plugin adds (node v22.22.2)
require the bundle         310.9 to 319.6 ms (319.6, 318.6, 310.9)
  heap it retains          35.4 MB (35.4, 35.4, 35.4)
build and answer for all   141 to 151.8 ms (151.8, 141, 150.4)
  heap it retains          5.2 MB (5.2, 5.2, 5.2)
retained, both phases      40.6 MB (40.6, 40.6, 40.6)
warm, one shader edit      6.7 to 7.2 ms (6.7, 6.8, 7.2)
diagnostics on shaders     0 (0, 0, 0)
```

The same fixture with the shader files copied ten times, so it holds 60 of them:

```
fixture: 150 .ts files, 60 .shade.ts files

## the editor today, no plugin (node v22.22.2)
cold, whole project        1337.8 to 1549.6 ms (1407.1, 1337.8, 1549.6)
warm, one shader edit      18.3 to 19 ms (18.3, 18.4, 19)
heap for the project       65.9 MB (65.9, 65.9, 65.9)
false errors on shaders    580 (580, 580, 580)

## what the plugin adds (node v22.22.2)
require the bundle         309.3 to 341.6 ms (309.3, 321.3, 341.6)
  heap it retains          35.4 MB (35.4, 35.4, 35.4)
build and answer for all   276.9 to 311.3 ms (276.9, 284.3, 311.3)
  heap it retains          8.1 MB (8.1, 8.1, 8.1)
retained, both phases      43.5 MB (43.5, 43.5, 43.5)
warm, one shader edit      6.9 to 8.6 ms (6.9, 7.8, 8.6)
diagnostics on shaders     0 (0, 0, 0)
```

Three runs of the PREVIOUS configuration, with `typescript` external, are worth keeping for what
they say about the method rather than about the plugin. PR 2 reported 78.9 to 90.5 ms and
11.8 MB for the require phase; an independent run in its review reported 117.8 to 128.5 ms with
the heap identical to 0.1 MB; a third run reported 93.5 to 100.5 ms, heap identical again. Heap
is what every run agrees on to the tenth of a megabyte; time is what a shared four-core
container moves, by a quarter or so. That is why the heap figures are the numbers to argue with
and the times are not.

## What the numbers say

| Question                                             | Answer                                                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Why a second program at all                          | tsserver alone reports 58 semantic errors on the six examples, and every one is false                     |
| What the plugin adds once per tsserver process       | 240.5 to 277.1 ms and 45 MB, to load its own code and its own `typescript`                                |
| What it adds once per project, 6 shaders             | 206.5 to 215.2 ms and 9.8 MB                                                                              |
| The same for 60 shaders                              | 400 to 516.6 ms and 15.1 MB                                                                               |
| Retained in tsserver, all phases                     | 54.8 MB for 6 shaders, 60.1 MB for 60, against 63.9 MB for the project program alone                      |
| What a keystroke in a shader file costs              | 9.1 to 10.6 ms in the TypeShade program, against 11.8 to 16.3 ms for the same file in the project program |
| Whether the project's size enters the second program | No: the 150 host modules are not in it                                                                    |

**Where the cost actually lives.** The fixed half is by far the larger one: loading the plugin's
own code costs 45 MB and about 260 ms whatever the project holds, flat to the tenth of a
megabyte between the 6-shader and the 60-shader fixture, and about 15.5 MB of it is the bundled
`typescript` rather than the compiler. The per-project half is what scales, and it scales on
shaders alone: ten times the shader files costs 5.3 MB more and roughly twice the time, while
the 150 host modules contribute nothing to either. That is a consequence of a language rule
rather than of tuning, because a TypeShade program holds the shader files and `SHADE_DTS` and
nothing else (`docs/design.md` §1.7).

The comparison that matters is the last two rows against the first: 54.8 MB and about 470 ms,
once, to replace 58 wrong answers with none, in a process that is already holding 63.9 MB for
the project itself. The 15.5 MB of `typescript` inside that is the one part a design change could
remove, and `docs/design.md` §8 item 11 is the question of whether to.

## What is not measured here

The plugin's own per-request decoration overhead, and the cost of syncing a document from
tsserver's script snapshots. Both are properties of code that does not exist yet, and the
plugin's own suite measures them where they land (`docs/design.md` §6). The numbers above are of
the two language services, which is what the delivery decision rests on.
