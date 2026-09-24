// === Running one shader function on the CPU ===
//
// The engine is the compiler's stepping interpreter (`typeshade/debug`, `docs/design.md` §5),
// the same one the editor's debug adapter drives, so an agent asking "what does this shader
// return for this pixel" gets the answer the compiler's own reference gives, at f32 by default
// because that is what a GPU computes.
//
// One departure from the adapter's path is deliberate. The adapter makes one call,
// `startDebugSessionFromConfig`, and that call takes no step budget. The engine's own
// documentation says a caller running someone else's shader should set one, because a run is a
// loop on the caller's thread that nothing can interrupt; here the caller is the server and the
// shader is an agent's. So this module does what that call does, with the two public resolvers
// it is built from (`resolveInvocation`, `resolveBindings`), and hands `startDebugSession` a
// `maxSteps` as well. A shader that runs too long then ends the tool call with a sentence
// instead of hanging the server. typeshade/typeshade#215 asks for the key in the launch
// configuration, which would let this module make the one call.

import {
  createValueFormatter,
  resolveBindings,
  resolveInvocation,
  stageOf,
  startDebugSession,
  typeKey,
  type ConsoleEvent,
  type CpuValue,
  type DebugInvocation,
  type DebugPause,
  type FuncDecl,
  type ModuleDecl,
  type ShaderType,
  type StructDecl,
} from './compiler.js';
import { ToolError } from './errors.js';

/** Statements one run may reach. The compiler bounds no loop's trips (a `for` may count to a
 *  runtime value and a `while` is open, typeshade/typeshade#209), so this budget is the only
 *  thing that ends a run written to never finish; a real shader reaches far fewer. */
export const STEP_LIMIT = 2_000_000;

/** Breakpoint stops one run reports before it stops stopping and runs to the end. */
export const STOP_LIMIT = 20;

/** Logged lines one run reports; later ones are counted, not printed. */
export const LOG_LIMIT = 50;

/** What the agent asked to run. */
export interface RunRequest {
  /** The function, an entry point or a helper, by name. */
  readonly function: string;
  /** Positional arguments. What a helper takes; an entry point may take them too. */
  readonly args?: readonly unknown[];
  /** An entry point's inputs, keyed by `@builtin` id, with `@location` inputs under `inputs`. */
  readonly invocation?: Readonly<Record<string, unknown>>;
  /** Uniform and storage values by declared name. */
  readonly bindings?: Readonly<Record<string, unknown>>;
  /** `f32` (what a GPU computes, the default) or `f64` (the algebra, without f32 rounding). */
  readonly precision?: 'f32' | 'f64';
  /** One-based lines to stop at; every stop reports the frame's locals. */
  readonly breakpoints?: readonly number[];
  /** Let the GPU-only intrinsics (derivatives, texture reads) return placeholders. */
  readonly gpuStubs?: boolean;
}

/**
 * Runs one function of a compiled module and describes what happened.
 *
 * @param module - the module `compile()` produced, with no error diagnostics.
 * @param request - what to run and with what.
 * @param limits - a smaller step budget, for a test that wants to reach it quickly.
 * @returns the returned value, each breakpoint stop with its locals, and any stand-in warning.
 * @throws ToolError when the request does not fit the module, or the run fails partway (a step
 *   budget exceeded, a GPU-only intrinsic without `gpuStubs`), with the stops reached so far.
 */
export function runOnCpu(
  module: ModuleDecl,
  request: RunRequest,
  limits: { readonly maxSteps?: number } = {},
): string {
  const decl = module.funcs.find((f) => f.name === request.function);
  if (decl === undefined) {
    const names = module.funcs.map(signatureOf).join('\n  ');
    throw new ToolError(
      `There is no function ${JSON.stringify(request.function)} in this module. It declares:\n  ` +
        (names || '(nothing)'),
    );
  }
  const structs = new Map(module.structs.map((s) => [s.name, s]));
  const problems: string[] = [];
  const stage = stageOf(decl);

  let args: CpuValue[];
  if (request.args !== undefined) {
    args = checkArguments(decl, request.args, structs, problems);
    if (request.invocation !== undefined) {
      problems.push('Pass either `args` or `invocation`, not both.');
    }
  } else if (stage !== undefined) {
    args = resolveInvocation(
      decl,
      (request.invocation ?? {}) as DebugInvocation,
      structs,
      problems,
    );
  } else {
    args = [];
    if (request.invocation !== undefined) {
      problems.push(
        `\`invocation\` is for an entry point, and ${decl.name} is a helper: pass its ` +
          'arguments as `args`.',
      );
    } else if (decl.params.length > 0) {
      problems.push(`${signatureOf(decl)} needs its arguments, as \`args\`.`);
    }
  }
  const bindings = resolveBindings(
    module,
    (request.bindings ?? {}) as Record<string, CpuValue>,
    structs,
    problems,
    decl,
  );
  if (problems.length > 0) {
    throw new ToolError(`The run did not start:\n- ${problems.join('\n- ')}`);
  }

  const precision = request.precision ?? 'f32';
  const format = createValueFormatter(module, precision);
  const stops: string[] = [];
  // Every `console.*` call the run makes, in order (compiler proposal 0018, surface §66).
  const logged: ConsoleEvent[] = [];
  let failure: string | undefined;
  try {
    const session = startDebugSession(module, decl.name, args, {
      consoleSink: (e) => logged.push(e),
      precision,
      gpuStubs: request.gpuStubs === true,
      bindings,
      breakpoints: (request.breakpoints ?? []).map((line) => ({ line: line - 1 })),
      stopOnEntry: false,
      maxSteps: limits.maxSteps ?? STEP_LIMIT,
    });
    while (!session.done) {
      const pause = session.pause;
      if (pause?.reason === 'breakpoint') {
        stops.push(describeStop(pause, format));
        if (stops.length >= STOP_LIMIT) session.setBreakpoints([]);
      }
      session.continue();
    }
    const outcome = session.discarded
      ? `${decl.name} discarded the fragment (it reached \`discard\`).`
      : session.result === undefined
        ? `${decl.name} returned nothing.`
        : `${decl.name} returned ${format(session.result, decl.ret)}`;
    const out = [`${outcome}\nprecision: ${precision}`];
    if (session.stubbedIntrinsics.length > 0) {
      out.push(
        `Stand-ins: ${session.stubbedIntrinsics.join(', ')} returned placeholders, not what a ` +
          'GPU computes, and so does anything computed from them.',
      );
    }
    if (logged.length > 0) out.push(describeLog(logged, format));
    if (stops.length > 0) out.push(`${stopsHeading(stops.length, request)}\n${stops.join('\n')}`);
    else if ((request.breakpoints ?? []).length > 0) {
      out.push('No breakpoint was reached: those lines hold no statement this run executed.');
    }
    return out.join('\n\n');
  } catch (error) {
    if (error instanceof ToolError) throw error;
    failure = error instanceof Error ? error.message : String(error);
  }
  // The engine's own message already names the way out where there is one (a GPU-only
  // intrinsic says to start with `gpuStubs: true`, which is this tool's parameter too).
  const report = [`The run of ${decl.name} failed: ${failure}`];
  if (logged.length > 0) report.push(describeLog(logged, format));
  if (stops.length > 0) report.push(`${stopsHeading(stops.length, request)}\n${stops.join('\n')}`);
  throw new ToolError(report.join('\n\n'));
}

/** The lines a run logged, one per call, as the host console would print them: the labels as
 *  written and each value through the formatter, after the line and the method. */
function describeLog(
  logged: readonly ConsoleEvent[],
  format: (value: CpuValue, type?: ShaderType) => string,
): string {
  const lines = logged.slice(0, LOG_LIMIT).map((e) => {
    const where = e.span ? `line ${e.span.line + 1}, ` : '';
    const text = e.args.map((a) => (typeof a === 'string' ? a : format(a))).join(' ');
    return `${where}console.${e.method}: ${text}`;
  });
  const heading = `Logged ${logged.length === 1 ? '1 line' : `${logged.length} lines`}:`;
  const more = logged.length > LOG_LIMIT ? `\n(${logged.length - LOG_LIMIT} more not shown)` : '';
  return `${heading}\n${lines.join('\n')}${more}`;
}

/** The heading over the breakpoint stops, saying when they were cut short. */
function stopsHeading(count: number, request: RunRequest): string {
  const lines = (request.breakpoints ?? []).join(', ');
  return count >= STOP_LIMIT
    ? `Stopped ${count} times at line ${lines}; later hits were run through without stopping.`
    : `Stopped ${count === 1 ? 'once' : `${count} times`} at line ${lines}:`;
}

/** One breakpoint stop, on one line: where, through which calls, and every local of the
 *  innermost frame. One line each, because a breakpoint in a loop stops once per trip and the
 *  point of reading them is to compare the trips. */
function describeStop(
  pause: DebugPause,
  format: (value: CpuValue, type?: ShaderType) => string,
): string {
  const [frame] = pause.frames;
  const stack = pause.frames
    .map((f) => f.fnName)
    .reverse()
    .join(' > ');
  const locals = [...frame.locals].map(([name, value]) => {
    const stub = frame.stubbedLocals.has(name) ? ' (stand-in)' : '';
    return `${name} = ${format(value, frame.localTypes.get(name))}${stub}`;
  });
  return `line ${pause.span.line + 1}, in ${stack}: ${locals.length ? locals.join(', ') : '(no locals yet)'}`;
}

/** A function as an agent would call it: `hash(p: vec2<f32>, k: f32) -> f32`, with its stage. */
export function signatureOf(f: FuncDecl): string {
  const params = f.params.map((p) => `${p.name}: ${typeName(p.type)}`).join(', ');
  const stage = stageOf(f);
  return `${f.name}(${params}) -> ${typeName(f.ret)}${stage ? `  [${stage} entry]` : ''}`;
}

/** A type as the author reads it. The compiler's `typeKey` is a cache key, and it spells a
 *  struct `struct:Name`; everything else it spells the way WGSL does, which is what hover shows
 *  too, so only the struct (and an array of one) is respelled here. */
function typeName(t: ShaderType): string {
  if (t.kind === 'struct') return t.name;
  if (t.kind === 'array') {
    return `array<${typeName(t.elem)}${t.size === undefined ? '' : `, ${t.size}`}>`;
  }
  return typeKey(t);
}

/** Positional arguments checked against the declared parameters, so a `vec3` passed for a
 *  `vec2` is a sentence now rather than a `NaN` in the result. */
function checkArguments(
  decl: FuncDecl,
  given: readonly unknown[],
  structs: ReadonlyMap<string, StructDecl>,
  problems: string[],
): CpuValue[] {
  if (given.length !== decl.params.length) {
    problems.push(
      `${signatureOf(decl)} takes ${decl.params.length} argument` +
        `${decl.params.length === 1 ? '' : 's'}; ${given.length} given.`,
    );
    return [];
  }
  decl.params.forEach((p, i) => {
    const problem = shapeProblem(given[i], p.type, structs);
    if (problem !== undefined) problems.push(`argument ${p.name}: ${problem}`);
  });
  return given as CpuValue[];
}

/** What is wrong with `value` as a value of `type` in the CPU value model, if anything: a
 *  number or boolean for a scalar, a flat array for a vector or a column-major matrix, an array
 *  for an array, an object keyed by field name for a struct. */
function shapeProblem(
  value: unknown,
  type: ShaderType,
  structs: ReadonlyMap<string, StructDecl>,
): string | undefined {
  const want = typeName(type);
  const numbers = (n: number, element: 'number' | 'boolean'): string | undefined =>
    Array.isArray(value) && value.length === n && value.every((v) => typeof v === element)
      ? undefined
      : `expected ${want} as an array of ${n} ${element}s, got ${JSON.stringify(value)}`;
  switch (type.kind) {
    case 'scalar':
      if (type.scalar === 'bool') {
        return typeof value === 'boolean'
          ? undefined
          : `expected a boolean, got ${JSON.stringify(value)}`;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `expected ${want} as a number, got ${JSON.stringify(value)}`;
      }
      if (type.scalar !== 'f32' && !Number.isInteger(value)) return `expected an integer ${want}`;
      if (type.scalar === 'u32' && value < 0) return 'expected a u32, which is not negative';
      return undefined;
    case 'f64':
      return typeof value === 'number'
        ? undefined
        : `expected f64 as a number, got ${JSON.stringify(value)}`;
    case 'vec':
      return numbers(type.n, type.elem === 'bool' ? 'boolean' : 'number');
    case 'vec64':
      return numbers(type.n, 'number');
    case 'mat':
      return numbers(type.cols * type.rows, 'number');
    case 'array': {
      if (!Array.isArray(value))
        return `expected ${want} as an array, got ${JSON.stringify(value)}`;
      if (type.size !== undefined && value.length !== type.size) {
        return `expected ${type.size} elements, got ${value.length}`;
      }
      for (let i = 0; i < value.length; i++) {
        const inner = shapeProblem(value[i], type.elem, structs);
        if (inner !== undefined) return `element ${i}: ${inner}`;
      }
      return undefined;
    }
    case 'struct': {
      const decl = structs.get(type.name);
      if (
        decl === undefined ||
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value)
      ) {
        return `expected a ${type.name} as an object keyed by field name, got ${JSON.stringify(value)}`;
      }
      const record = value as Record<string, unknown>;
      const fields = new Set(decl.fields.map((f) => f.name));
      const unknown = Object.keys(record).filter((k) => !fields.has(k));
      if (unknown.length > 0) {
        return `${type.name} has no field ${unknown.join(', ')}; its fields are ${[...fields].join(', ')}`;
      }
      for (const field of decl.fields) {
        if (!Object.hasOwn(record, field.name)) return `${type.name}.${field.name} is missing`;
        const inner = shapeProblem(record[field.name], field.type, structs);
        if (inner !== undefined) return `${type.name}.${field.name}: ${inner}`;
      }
      return undefined;
    }
    default:
      return `a ${want} cannot be passed to a CPU run`;
  }
}
