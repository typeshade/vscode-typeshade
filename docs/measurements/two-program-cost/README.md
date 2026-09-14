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

One more correction came out of the rewrite. The bundle leaves `typescript` external, so
requiring it also requires `typescript`, and charging the plugin for that put the require phase
at 284.6 to 350.5 ms and 27 MB. tsserver has `typescript` loaded before it asks for any plugin,
so the harness loads it before taking its baseline; the honest figure is a third of that.

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
harness: 76.8 to 96.8 ms and 11.8 MB to require the bundle, then 87.3 to 94.7 ms and 3.7 MB to
build and compile one document, 15.5 MB retained.

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

2026-09-14, in the session's container: 4 cores, node v22.22.2 doing the measuring, bun 1.3.11
driving, typescript 5.6.3, compiler at `a2240e0`, bundle 470 KB.

```
## the editor today, no plugin (node v22.22.2)
cold, whole project        1048.7 to 1088.5 ms (1073.5, 1048.7, 1088.5)
warm, one shader edit      14.7 to 15.6 ms (15.6, 14.7, 15.1)
heap for the project       63.8 to 63.9 MB (63.9, 63.9, 63.8)
false errors on shaders    58 (58, 58, 58)
                           compute-reduction-twin.shade.ts: 12 (TS1206 TS2304 TS2552)
                           hello-camera.shade.ts: 4 (TS2304)
                           hello-uniform.shade.ts: 5 (TS1206 TS2304)
                           hello-vsin.shade.ts: 14 (TS1206 TS2304 TS2349)
                           hello-vsout.shade.ts: 13 (TS1206 TS2304 TS2349)
                           hello.shade.ts: 10 (TS1206 TS2304 TS2349)

## what the plugin adds (node v22.22.2)
require the bundle         78.9 to 90.5 ms (78.9, 78.9, 90.5)
  heap it retains          11.8 MB (11.8, 11.8, 11.8)
build and answer for all   119.7 to 129.7 ms (119.7, 129.7, 127.8)
  heap it retains          5.1 MB (5.1, 5.1, 5.1)
retained, both phases      16.9 MB (16.9, 16.9, 16.9)
warm, one shader edit      5.9 to 6.2 ms (5.9, 6.1, 6.2)
diagnostics on shaders     0 (0, 0, 0)
```

The same fixture with the shader files copied ten times, so it holds 60 of them:

```
fixture: 150 .ts files, 60 .shade.ts files

## the editor today, no plugin (node v22.22.2)
cold, whole project        1115.9 to 1190.9 ms (1190.9, 1115.9, 1143)
warm, one shader edit      14.9 to 18.2 ms (18.2, 14.9, 15)
heap for the project       65.9 MB (65.9, 65.9, 65.9)
false errors on shaders    580 (580, 580, 580)

## what the plugin adds (node v22.22.2)
require the bundle         76 to 83.7 ms (83.7, 79, 76)
  heap it retains          11.8 MB (11.8, 11.8, 11.8)
build and answer for all   234.9 to 264.8 ms (264.8, 234.9, 249.7)
  heap it retains          8 MB (8, 8, 8)
retained, both phases      19.8 MB (19.8, 19.8, 19.8)
warm, one shader edit      5.6 to 5.7 ms (5.6, 5.7, 5.7)
diagnostics on shaders     0 (0, 0, 0)
```

An independent run of the same method, in the review of this pull request, reported the heap
figures identically (11.7 MB for the require phase, 5.1 MB for the build phase, 16.8 MB
retained) and higher times (117.8 to 128.5 ms and 171.1 to 280.5 ms). Heap is what the two
agree on to the tenth of a megabyte; time is what a shared four-core container moves.

## What the numbers say

| Question                                             | Answer                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Why a second program at all                          | tsserver alone reports 58 semantic errors on the six examples, and every one is false                    |
| What the plugin adds once per tsserver process       | 78.9 to 90.5 ms and 11.8 MB, to load its own code                                                        |
| What it adds once per project, 6 shaders             | 119.7 to 129.7 ms and 5.1 MB                                                                             |
| The same for 60 shaders                              | 234.9 to 264.8 ms and 8.0 MB                                                                             |
| Retained in tsserver, all phases                     | 16.9 MB for 6 shaders, 19.8 MB for 60, against 63.8 MB for the project program alone                     |
| What a keystroke in a shader file costs              | 5.9 to 6.2 ms in the TypeShade program, against 14.7 to 15.6 ms for the same file in the project program |
| Whether the project's size enters the second program | No: the 150 host modules are not in it                                                                   |

**Where the cost actually lives.** The fixed half is the larger one: loading the plugin's own
code costs 11.8 MB and about 80 ms whatever the project holds, and both are flat between the
6-shader and the 60-shader fixture. The per-project half is what scales, and it scales on
shaders alone: ten times the shader files costs 2.9 MB more and roughly twice the time, while
the 150 host modules contribute nothing to either. That is a consequence of a language rule
rather than of tuning, because a TypeShade program holds the shader files and `SHADE_DTS` and
nothing else (`docs/design.md` §1.7).

The comparison that matters is the last two rows against the first: 16.9 MB and about 200 ms,
once, to replace 58 wrong answers with none, in a process that is already holding 63.8 MB for
the project itself.

## What is not measured here

The plugin's own per-request decoration overhead, and the cost of syncing a document from
tsserver's script snapshots. Both are properties of code that does not exist yet, and the
plugin's own suite measures them where they land (`docs/design.md` §6). The numbers above are of
the two language services, which is what the delivery decision rests on.
