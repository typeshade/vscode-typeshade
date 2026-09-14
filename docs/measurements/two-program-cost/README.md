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

## The run the design document reports

2026-09-14, in the session's container: 4 cores, node v24.3.0 under bun 1.3.11, typescript
5.6.3, compiler at `3c0a2d7`.

```
node v24.3.0, typescript 5.6.3, bun 1.3.11
fixture: 150 .ts files, 6 .shade.ts files

## project program only (no plugin)
cold        1211.7 ms
warm/edit   14.4 ms
heap        83.2 MB
            58 diagnostics over 156 files
            hello.shade.ts: 10 semantic (TS1206 TS2304 TS2349)
            hello-uniform.shade.ts: 5 semantic (TS1206 TS2304)
            hello-camera.shade.ts: 4 semantic (TS2304)
            hello-vsin.shade.ts: 14 semantic (TS1206 TS2304 TS2349)
            hello-vsout.shade.ts: 13 semantic (TS1206 TS2304 TS2349)
            compute-reduction-twin.shade.ts: 12 semantic (TS1206 TS2304)

## project program plus the TypeShade program
cold        63.3 ms
warm/edit   5.6 ms
heap        86.4 MB
            heap 82 MB with the project program alone, 86.4 MB once the
              TypeShade program was built and had answered for every shader file
            0 diagnostics over 6 shader files
            hello.shade.ts: 0 (-)
            hello-uniform.shade.ts: 0 (-)
            hello-camera.shade.ts: 0 (-)
            hello-vsin.shade.ts: 0 (-)
            hello-vsout.shade.ts: 0 (-)
            compute-reduction-twin.shade.ts: 0 (-)
```

With the shader files copied ten times, so the fixture holds 60 of them:

```
fixture: 150 .ts files, 60 .shade.ts files

## project program only (no plugin)
cold        1350.6 ms
warm/edit   20.7 ms
heap        126.5 MB
            580 diagnostics over 210 files

## project program plus the TypeShade program
cold        206.3 ms
warm/edit   4.9 ms
heap        89.1 MB
            heap 80.7 MB with the project program alone, 89.1 MB once the
              TypeShade program was built and had answered for every shader file
            0 diagnostics over 60 shader files
```

## What the numbers say

| Question                                             | Answer                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Why a second program at all                          | tsserver alone reports 58 semantic errors on the six examples, and every one is false             |
| What the second program costs to build               | 63.3 ms for 6 shader files, 206.3 ms for 60                                                       |
| What it retains                                      | 4.4 MB for 6 shader files, 8.4 MB for 60                                                          |
| What a keystroke in a shader file costs              | 5.6 ms in the TypeShade program, against 14.4 ms for the same file in the project program         |
| Whether the project's size enters the second program | No: the fixture's 150 host modules are not in it, so both numbers scale on the shader count alone |

The last row is the reason the cost is small, and it is a consequence of a language rule rather
than an optimization: a TypeShade program holds the shader files and `SHADE_DTS`, and nothing
else, because a `"use typeshade"` file's only meaningful imports are other `"use typeshade"`
files (`docs/design.md` §1.7). A project three times the size costs the second program nothing.

## What is not measured here

The plugin's own decoration overhead per request, and the cost of syncing a document from
tsserver's script snapshots. Both are properties of code that does not exist yet, and the
plugin's own test suite measures them where they land (`docs/design.md` §6). The numbers above
are of the two language services, which is what the delivery decision rests on.
