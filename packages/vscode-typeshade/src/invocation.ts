// === Reading what the user typed into `TypeShade: Run Entry on CPU` ===
//
// `docs/design.md` §4: the command picks an entry, asks for the invocation, runs it on the CPU
// oracle and shows the returned value. This module is the middle step, and it has no `vscode` in
// it so §6's unit tests can cover it.
//
// The validation here is deliberately shallow: arity, and the shape each parameter's type
// demands. It is not a type checker. The oracle is the thing that actually runs, and a value
// this accepts can still be wrong for the shader in a way only running it shows. What this
// catches is the class of mistake an input box invites: three numbers for a `vec4`, a string
// where a number goes, a missing argument.

import type { CpuValue, ShaderType } from './compiler.js'

/** One parameter of the entry being invoked. */
export interface InvocationParameter {
  /** The declared name, used in the prompt and in an error message. */
  readonly name: string
  /** Its declared type. */
  readonly type: ShaderType
}

/** What `parseInvocation` returns: the values to pass, or the one thing wrong with the input. */
export type InvocationResult =
  | { readonly ok: true; readonly values: readonly CpuValue[] }
  | { readonly ok: false; readonly error: string }

/**
 * Turns the text of the invocation box into the arguments the compiled entry takes.
 *
 * The text is a comma-separated argument list in JSON spelling, which is the notation a shader
 * author already writes for a vector: `3, [0.5, 0.5, 0, 1], true`. It is parsed as a JSON array
 * rather than by hand, so a trailing comma or an unquoted identifier is rejected with a parse
 * error instead of quietly becoming something else.
 *
 * @param text - what the user typed. Empty means no arguments.
 * @param params - the entry's parameters, in declaration order.
 * @returns the values, or the first problem found.
 */
export function parseInvocation(
  text: string,
  params: readonly InvocationParameter[],
): InvocationResult {
  const trimmed = text.trim()
  let values: unknown[]
  if (trimmed === '') {
    values = []
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(`[${trimmed}]`)
    } catch {
      return { ok: false, error: `${describe(params)} could not be read as a JSON argument list` }
    }
    values = parsed as unknown[]
  }
  if (values.length !== params.length) {
    return {
      ok: false,
      error: `expected ${params.length} argument${params.length === 1 ? '' : 's'}, got ${values.length}: ${describe(params)}`,
    }
  }
  for (const [index, param] of params.entries()) {
    const problem = check(values[index], param.type)
    if (problem !== undefined) return { ok: false, error: `${param.name}: ${problem}` }
  }
  return { ok: true, values: values as CpuValue[] }
}

/** The invocation box's prompt, which is the signature the user is filling in. */
export function describe(params: readonly InvocationParameter[]): string {
  if (params.length === 0) return '(no arguments)'
  return params.map((param) => `${param.name}: ${spell(param.type)}`).join(', ')
}

/** A type as a shader author writes it, for a prompt and for an error message. */
export function spell(type: ShaderType): string {
  switch (type.kind) {
    case 'scalar':
      return type.scalar
    case 'f64':
      return 'f64'
    case 'vec64':
      return `vec${type.n}d`
    case 'vec':
      return `vec${type.n}${suffix(type.elem)}`
    case 'mat':
      return `mat${type.n}x${type.n}${suffix(type.elem)}`
    case 'struct':
      return type.name
    case 'array':
      return type.size === undefined ? `${spell(type.elem)}[]` : `${spell(type.elem)}[${type.size}]`
    default:
      // Textures and samplers, which `check` refuses: there is no value to type for one.
      return type.kind
  }
}

/** The letter that follows a vector or matrix's dimension for a non-`f32` element. */
function suffix(elem: string): string {
  return elem === 'f32' ? '' : elem[0]
}

/** What is wrong with `value` for `type`, or undefined when nothing is. */
function check(value: unknown, type: ShaderType): string | undefined {
  switch (type.kind) {
    case 'scalar':
      if (type.scalar === 'bool') {
        return typeof value === 'boolean' ? undefined : `expected true or false for bool`
      }
      return number(value, type.scalar)
    case 'f64':
      return number(value, 'f64')
    case 'vec':
    case 'vec64':
      return components(value, type.n, spell(type))
    case 'mat':
      // A matrix is its columns, each a vector of the same length, which is how the oracle's
      // own values are shaped.
      if (!Array.isArray(value) || value.length !== type.n) {
        return `expected ${type.n} columns for ${spell(type)}`
      }
      for (const column of value) {
        const problem = components(column, type.n, spell(type))
        if (problem !== undefined) return problem
      }
      return undefined
    case 'struct':
      return isPlainObject(value) ? undefined : `expected an object for ${type.name}`
    case 'array':
      return Array.isArray(value) ? undefined : `expected an array for ${spell(type)}`
    default:
      // A texture or a sampler is a GPU resource, and the oracle stubs those rather than taking
      // one as an argument. There is nothing a user could type here.
      return `${spell(type)} cannot be passed to an entry run on the CPU`
  }
}

/** An integer or a float, as a number rather than as anything JSON also allows. */
function number(value: unknown, type: string): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `expected a number for ${type}`
  if ((type === 'i32' || type === 'u32') && !Number.isInteger(value)) {
    return `expected an integer for ${type}`
  }
  if (type === 'u32' && value < 0) return `expected a non-negative integer for u32`
  return undefined
}

/** An array of exactly `n` numbers. */
function components(value: unknown, n: number, spelled: string): string | undefined {
  if (!Array.isArray(value) || value.length !== n) return `expected ${n} numbers for ${spelled}`
  return value.every((component) => typeof component === 'number' && Number.isFinite(component))
    ? undefined
    : `expected ${n} numbers for ${spelled}`
}

/** An object literal, which is what a struct argument is. Excludes arrays and null, both of
 *  which `typeof` calls an object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
