# TypeShade diagnostics

`TS8xxx` codes are TypeShade's own, defined in the compiler's `src/compiler/ts/codes.ts`.
TypeScript's checker still runs over a shader, and a plain TypeScript code (`TS2304`, `TS2345`)
comes from it; the language service drops the ones that are false for shader code, so any that
reach you are real. The two families overlap in number (TypeScript also has an 8001 to 8039),
which is why the tools print the source beside the code.

**Fix the first error first.** A declaration that failed to lower makes every later use of its
name a `TS8022 Unknown identifier`, so one mistake can read as five.

| Code   | Name                      | Typical cause                                                                                                                                                                                                                                                           | Fix                                                          |
| ------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| TS8001 | MISSING_DIRECTIVE         | the file does not start with `"use typeshade"`                                                                                                                                                                                                                          | add it as the first line                                     |
| TS8002 | UNKNOWN_TYPE              | `number`, `boolean`, `float`, `T[]`, an unannotated parameter, `const xs = [...]` with no type                                                                                                                                                                          | a shader type, annotated                                     |
| TS8003 | TYPE_MISMATCH             | `f32 + i32`; an index that is an f32 (an unannotated `let i = 0`); a return of the wrong type; a non-bool `if`; `vec3 * vec4`; `mat4 * vec3`; `f32(v)` on a vector; a constant division by zero                                                                         | cast explicitly, annotate integer locals, match the sizes    |
| TS8004 | UNKNOWN_FN                | a call to a name TypeShade does not have: `lerp`, `texture`, a function imported from another shader                                                                                                                                                                    | `docs` for the TypeShade name; keep helpers in the same file |
| TS8005 | CONST_ASSIGN              | a write to a `const`, a read-only resource (a `uniform`, or a `storage<T>` without `"read_write"`), or a `readonly` field                                                                                                                                               | `let`, or `declare let ... storage<T>`                       |
| TS8006 | LOOP_BOUND                | a loop bound the body writes; `!=` against a runtime bound; a runtime-bounded `*=` whose factor is not a whole 2 or more; a constant loop that leaves its type                                                                                                          | read the bound into a `const`; compare with `<`              |
| TS8007 | LOOP_INFINITE             | `while (true)` with no `break` or `return` in its body, a `for` with no condition, a step moving away from the bound                                                                                                                                                    | a counted loop                                               |
| TS8008 | LOOP_INDUCTION            | a float induction variable, or an initializer or update the loop rule does not accept                                                                                                                                                                                   | `for (let i = 0; i < N; i++)`                                |
| TS8009 | BREAK_OUTSIDE             | `break` or `continue` outside a loop or switch                                                                                                                                                                                                                          | move it                                                      |
| TS8010 | STRUCT_FIELD              | a missing, extra or optional field; `@align`; a varying whose name or type differs between the stages                                                                                                                                                                   | match the struct; share one IO class                         |
| TS8012 | HOST_API                  | a JavaScript global: `Number`, `Array`, `Date`, `JSON`, `window`                                                                                                                                                                                                        | a builtin; only `Math` and `console` exist                   |
| TS8013 | HOST_STMT                 | `var`, `for...in`, `try`, `async`, a template string, `new` on a class the file does not declare                                                                                                                                                                        | shader statements                                            |
| TS8014 | TOP_LEVEL                 | an expression or an `if` at the top level                                                                                                                                                                                                                               | move it into a function                                      |
| TS8015 | BACKEND                   | an emitter refused the module. A warning drops the GLSL only (a uniform that is not a struct, `mat2` in a uniform, `@interpolate("linear")`, a compute entry beside the render pair, a GLSL-reserved name). An error drops everything (a bare `uniform<array<f32, 4>>`) | read the message; wrap a uniform in a struct                 |
| TS8016 | INDEX_OOB                 | a constant index outside a fixed-size array                                                                                                                                                                                                                             | fix the index                                                |
| TS8017 | SWITCH_CASE               | a case label that is not an integer constant, a repeated label, an empty case above `default:`                                                                                                                                                                          | integer constants                                            |
| TS8018 | ASSIGN_TARGET             | a write to a parameter, to a multi-component swizzle (`v.xy = ...`), `++` on a vector                                                                                                                                                                                   | copy into a `let`; write one component                       |
| TS8019 | ARITY_MISMATCH            | the wrong number of arguments; `vec4(x, x)`; `Math.random()`                                                                                                                                                                                                            | check the signature with `docs`; `random(seed)`              |
| TS8020 | FUNCTION_SHAPE            | an optional or rest parameter; a default that reads another parameter; a vertex entry with no position output; `declare function`                                                                                                                                       | a plain parameter; return the position                       |
| TS8021 | RETURN_SHAPE              | a value-returning entry with no return annotation; a bare `return` in a function that returns a value                                                                                                                                                                   | annotate every return type                                   |
| TS8022 | UNKNOWN_NAME              | an unknown identifier, field or swizzle (`.st`); an object literal no struct matches; `undefined`; the cascade of an earlier error                                                                                                                                      | fix the first error                                          |
| TS8023 | DUPLICATE_SYMBOL          | one name declared twice in a scope, two interfaces of one name included                                                                                                                                                                                                 | rename                                                       |
| TS8024 | BUILTIN_NAME              | `@builtin("frag_coord")` and other ids WGSL does not have                                                                                                                                                                                                               | `@builtin("position")`; `docs` lists the ids                 |
| TS8025 | BUILTIN_STAGE             | a builtin in the wrong stage, such as `front_facing` in a vertex entry                                                                                                                                                                                                  | move it                                                      |
| TS8026 | WORKGROUP_SHAPE           | `@compute([8, 8])`: y and z must be 1                                                                                                                                                                                                                                   | `@compute([64])` over a linear index                         |
| TS8027 | MAT_UNSUPPORTED           | a non-square `f64` matrix; only square ones are emulated                                                                                                                                                                                                                | `mat3x3<f64>`, `mat4x4<f64>`, or `f32`                       |
| TS8028 | ATTRIBUTE_NAME            | a misspelled decorator (`@vertx`), `@size`, `@offset`                                                                                                                                                                                                                   | the right attribute                                          |
| TS8029 | STRUCT_FIELD_MISSING_ATTR | an IO struct field with neither `@location` nor `@builtin`; `@location` on a compute entry                                                                                                                                                                              | attribute every IO field                                     |
| TS8030 | SYNTAX                    | a TypeScript parse error; nothing is compiled                                                                                                                                                                                                                           | fix the syntax                                               |
| TS8031 | RECURSION                 | a function that reaches itself                                                                                                                                                                                                                                          | a loop                                                       |
| TS8032 | UNSIZED_ARRAY_LENGTH      | `.length` on an `array<T>` that is not in storage                                                                                                                                                                                                                       | give it a size                                               |
| TS8033 | MODULE_VAR                | a module variable in the wrong place: workgroup memory in a vertex or fragment entry, `let x: storage<T>` without `declare`                                                                                                                                             | `declare` the resource; workgroup memory in compute only     |
| TS8034 | BARRIER_PLACEMENT         | a barrier in a vertex or fragment entry, or used as a value                                                                                                                                                                                                             | compute only, as a statement                                 |
| TS8035 | CLASS_MEMBER              | a stage decorator on a method; a method that assigns to `this` called on a `const`                                                                                                                                                                                      | a top-level entry; a `let` receiver                          |
| TS8036 | MATH_ARGUMENT             | a scalar beside a vector in a builtin: `max(v, 0.)`, `step(0.5, v)`, `pow(v, 2.)`                                                                                                                                                                                       | splat: `max(v, vec3(0.))`                                    |
| TS8037 | WORKGROUP_ARG             | `@compute({ workgroup: [...] })` or another argument shape `@compute` does not take                                                                                                                                                                                     | `@compute([64])`                                             |
| TS8038 | F64_ENTRY_IO              | an `f64` on an entry's input or output                                                                                                                                                                                                                                  | convert at the boundary                                      |
| TS8041 | TEXTURE_ARGUMENT          | a coordinate or level of the wrong type, such as a float coordinate in `textureLoad`                                                                                                                                                                                    | `vec2i` coordinates for `textureLoad`                        |
| TS8050 | ENABLE_NAME               | a misspelled `"enable ..."` directive                                                                                                                                                                                                                                   | the extension's name                                         |
| TS8051 | LAYOUT                    | a `bool` in a buffer struct; a runtime-sized array in a uniform or not last in its struct                                                                                                                                                                               | `u32` instead of `bool`; move the array                      |
| TS8052 | UNIFORMITY                | `textureSample` or a derivative under a per-fragment branch or after an early return; a barrier under an id-dependent branch                                                                                                                                            | sample before the branch, or `textureSampleLevel`            |
| TS8053 | INT_LITERAL_DEPRECATION   | a warning, with `deprecations: true`, for an integer-written literal in an untyped declaration                                                                                                                                                                          | annotate the declaration                                     |
| TS8068 | RESERVED_NAME             | a WGSL reserved word used as a name (an error), or a GLSL one used for a struct, field or binding (a warning that drops the GLSL)                                                                                                                                       | rename                                                       |
| TS8099 | UNSUPPORTED               | the catch-all: a string, `==`, `>>>`, `do...while`, a label, `xs.filter(...)` (only `map`, `forEach`, `some`, `every` and `reduce` compile), `declare let` on a resource, a fragment-only call in another stage, a call to an entry                                     | the message names the construct and usually the fix          |

Two of them, produced exactly as shown:

<!-- expect: TS8006 -->

```ts
"use typeshade"
export function sum(n0: i32): f32 {
  let n = n0
  let total = 0.
  for (let i = 0; i < n; i++) {
    total += 1.
    n = n - 1
  }
  return total
}
```

<!-- expect: TS8018 -->

```ts
"use typeshade"
export function bump(v: vec3): vec3 {
  v.x = v.x + 1.
  return v
}
```

And the fixes:

```ts
"use typeshade"
export function sum(n0: i32): f32 {
  const n = n0
  let total = 0.
  for (let i = 0; i < n; i++) {
    total += 1.
  }
  return total
}

export function bump(v: vec3): vec3 {
  let w = v
  w.x = w.x + 1.
  return w
}
```
