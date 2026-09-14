# What a second TypeScript program costs

`docs/design.md` §1 chooses a TypeScript server plugin over a standalone language server, and
the choice turns on one number. A `"use typeshade"` file has to be type-checked by a program
built with `lib: []` and the ambient `SHADE_DTS`
(`typeshade/src/language-service/host.ts`, `typeshadeCompilerOptions`), while tsserver's own
project has the standard library. So the plugin runs a `TypeshadeLanguageService` of its own
beside the project's, and the question is what that second program costs.

[`measure.ts`](./measure.ts) answers it. Run it with `bun`, because the compiler's
`package.json` `exports` still point at TypeScript sources:

```bash
npm install   # the workspace's own typescript, which the compiler's sources resolve to
git clone https://github.com/typeshade/typeshade vendor/typeshade
bun docs/measurements/two-program-cost/measure.ts
SHADE_COPIES=10 bun docs/measurements/two-program-cost/measure.ts
```

`vendor/typeshade` is where the pinned submodule lands when the plugin is implemented
(`docs/design.md` §2); until it exists, a plain clone there does the same job, and
`TYPESHADE_COMPILER=/path/to/typeshade` overrides the location. The checkout has to sit inside
the workspace so that node's upward resolution finds the workspace's pinned `typescript`: with
a sibling checkout in this container, `typescript` resolved to a global 7.0.2 install and the
compiler's sources failed at module evaluation with `ts.SyntaxKind` undefined.

The fixture is 150 plain TypeScript modules with real edges between them (interfaces, a class
holding a `Map`, an `async` function, and imports of two siblings each) plus the compiler's own
six `.shade.ts` examples, under a `tsconfig.json` with `lib: ["ES2022", "DOM"]`. Memory is the
live heap after a forced collection, not resident set size: an earlier run of this script
reported the process holding 294.2 MB of RSS before the second program and 263.8 MB after it,
which says something about when the allocator returns pages and nothing about what the second
program retains.

## The runs the design document reports

Two runs, on two compiler revisions, in the session's container: 4 cores, node v24.3.0 under
bun 1.3.11, typescript 5.6.3. Two, because one sample hides how noisy a shared container is:
the numbers that matter agree between them, and the ones that wander are named below.

Compiler at `a2240e0` (the current `main`), 2026-09-14:

```
node v24.3.0, typescript 5.6.3, bun 1.3.11
fixture: 150 .ts files, 6 .shade.ts files

## project program only (no plugin)
cold        1511.7 ms
warm/edit   40.9 ms
heap        81.3 MB
            58 diagnostics over 156 files
            hello.shade.ts: 10 semantic (TS1206 TS2304 TS2349)
            hello-uniform.shade.ts: 5 semantic (TS1206 TS2304)
            hello-camera.shade.ts: 4 semantic (TS2304)
            hello-vsin.shade.ts: 14 semantic (TS1206 TS2304 TS2349)
            hello-vsout.shade.ts: 13 semantic (TS1206 TS2304 TS2349)
            compute-reduction-twin.shade.ts: 12 semantic (TS1206 TS2304)

## project program plus the TypeShade program
cold        59.5 ms
warm/edit   6 ms
heap        86.3 MB
            heap 82.7 MB with the project program alone, 86.3 MB once the
              TypeShade program was built and had answered for every shader file
            0 diagnostics over 6 shader files
            hello.shade.ts: 0 (-)
            hello-uniform.shade.ts: 0 (-)
            hello-camera.shade.ts: 0 (-)
            hello-vsin.shade.ts: 0 (-)
            hello-vsout.shade.ts: 0 (-)
            compute-reduction-twin.shade.ts: 0 (-)
```

The same fixture with the shader files copied ten times, so it holds 60 of them:

```
fixture: 150 .ts files, 60 .shade.ts files

## project program only (no plugin)
cold        1316.9 ms
warm/edit   20 ms
heap        120.2 MB
            580 diagnostics over 210 files

## project program plus the TypeShade program
cold        212.2 ms
warm/edit   7.2 ms
heap        89.3 MB
            heap 85.3 MB with the project program alone, 89.3 MB once the
              TypeShade program was built and had answered for every shader file
            0 diagnostics over 60 shader files
```

Compiler at `3c0a2d7`, the earlier run, quoted for the same rows only: 6 shaders cold 63.3 ms,
warm 5.6 ms, heap 82.0 MB to 86.4 MB, project warm 14.4 ms, 58 false diagnostics; 60 shaders
cold 206.3 ms, warm 4.9 ms, heap 80.7 MB to 89.1 MB, 580 false diagnostics.

**What is stable across the two, and what is not.** The diagnostic counts are exact and
identical: 58 and 580, the same codes on the same files, and zero from the TypeShade service.
The second program's cold build agrees closely (59.5 and 63.3 ms for 6, 212.2 and 206.3 ms for 60) and so does its warm cost (6.0 and 5.6 ms, 7.2 and 4.9 ms). Two numbers wander and should
be read as bounds, not as values: the heap the second program retains (3.6 to 4.4 MB for 6
shaders, 4.0 to 8.4 MB for 60, so under 10 MB in every run) and the project program's warm cost
for the same file (14.4, 20.7, 20.0 and 40.9 ms across four runs), which is a 156-file program
re-checking against the full standard library on a shared four-core container.

## What the numbers say

| Question                                             | Answer                                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Why a second program at all                          | tsserver alone reports 58 semantic errors on the six examples, and every one is false                    |
| What the second program costs to build               | 59.5 to 63.3 ms for 6 shader files, 206.3 to 212.2 ms for 60                                             |
| What it retains                                      | under 10 MB in every run: 3.6 to 4.4 MB for 6 shader files, 4.0 to 8.4 MB for 60                         |
| What a keystroke in a shader file costs              | 5.6 to 7.2 ms in the TypeShade program, against 14.4 to 40.9 ms for the same file in the project program |
| Whether the project's size enters the second program | No: the fixture's 150 host modules are not in it, so both numbers scale on the shader count alone        |

The last row is the reason the cost is small, and it is a consequence of a language rule rather
than an optimization: a TypeShade program holds the shader files and `SHADE_DTS`, and nothing
else, because a `"use typeshade"` file's only meaningful imports are other `"use typeshade"`
files (`docs/design.md` §1.7). A project three times the size costs the second program nothing.

## What is not measured here

The plugin's own decoration overhead per request, and the cost of syncing a document from
tsserver's script snapshots. Both are properties of code that does not exist yet, and the
plugin's own test suite measures them where they land (`docs/design.md` §6). The numbers above
are of the two language services, which is what the delivery decision rests on.
