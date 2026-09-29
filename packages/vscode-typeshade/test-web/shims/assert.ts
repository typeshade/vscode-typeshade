// === `node:assert/strict`, for a browser ===
//
// The web suite runs in a web extension host, which has no Node built-ins, and it shares its
// plugin cases with the electron suite (`test-shared/plugin-cases.ts`), which imports
// `node:assert/strict`. `scripts/build.mjs` bundles the web suite with this file standing in for
// that module. It implements the four calls the suites make (`ok`, `equal`, `notEqual`,
// `deepEqual`) with Node's strict-mode meaning, and nothing else. `src/web-shims.test.ts` runs it
// against Node's own `assert` on a table of inputs. A comparison it cannot make honestly (a `Map`,
// a `Date`) throws rather than passing, since a stand-in that says "equal" for a value it did not
// look at is worse than none.

/** What a failed assertion throws, as Node's is named. */
class AssertionError extends Error {
  override name = 'AssertionError';
}

/** Throws `message` when it is an `Error`, as Node's assert does, and a new error otherwise. */
function fail(message: string | Error | undefined, fallback: string): never {
  if (message instanceof Error) throw message;
  throw new AssertionError(message ?? fallback);
}

/** The kinds of value a structural comparison here does not attempt. Each has state a walk over
 *  own enumerable keys does not see, so comparing two of them would pass for the wrong reason. */
function refuseUnsupported(value: unknown): void {
  if (
    value instanceof Map ||
    value instanceof Set ||
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Error ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof Promise ||
    typeof value === 'function'
  ) {
    throw new TypeError(
      'the browser stand-in for node:assert/strict does not compare this kind of value',
    );
  }
}

/** Node's `assert.deepStrictEqual` for arrays, plain objects and primitives. */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  refuseUnsupported(a);
  refuseUnsupported(b);
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}

/** The subset of `node:assert/strict` the suites use. */
export interface Assert {
  (value: unknown, message?: string | Error): asserts value;
  ok(value: unknown, message?: string | Error): asserts value;
  equal(actual: unknown, expected: unknown, message?: string | Error): void;
  notEqual(actual: unknown, expected: unknown, message?: string | Error): void;
  deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
}

/** Throws unless `value` is truthy. */
function ok(value: unknown, message?: string | Error): asserts value {
  if (!value) fail(message, 'the expression evaluated to a falsy value');
}

const assert = ok as Assert;
assert.ok = ok;
assert.equal = (actual, expected, message) => {
  if (!Object.is(actual, expected)) {
    fail(message, `expected ${describe(expected)}, got ${describe(actual)}`);
  }
};
assert.notEqual = (actual, expected, message) => {
  if (Object.is(actual, expected))
    fail(message, `expected a value other than ${describe(expected)}`);
};
assert.deepEqual = (actual, expected, message) => {
  if (!same(actual, expected)) {
    fail(message, `expected ${describe(expected)}, got ${describe(actual)}`);
  }
};

/** A value as a short string for a failure message. */
function describe(value: unknown): string {
  try {
    return typeof value === 'string'
      ? JSON.stringify(value)
      : (JSON.stringify(value) ?? String(value));
  } catch {
    return String(value);
  }
}

export default assert;
