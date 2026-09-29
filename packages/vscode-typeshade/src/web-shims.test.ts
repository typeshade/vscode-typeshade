import { describe, expect, it } from 'vitest';
import nodeAssert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import shim from '../test-web/shims/assert.js';
import { setTimeout as shimDelay } from '../test-web/shims/timers.js';

/** Whether `call` throws. */
function throws(call: () => void): boolean {
  try {
    call();
    return false;
  } catch {
    return true;
  }
}

/** Values that exercise what a structural comparison has to tell apart. */
const VALUES: unknown[] = [
  0,
  -0,
  1,
  NaN,
  '',
  '1',
  true,
  false,
  null,
  undefined,
  [],
  [1],
  [1, 2],
  [1, '2'],
  [[]],
  {},
  { a: 1 },
  { a: 1, b: undefined },
  { a: undefined },
  { b: undefined },
  { a: { b: [1, { c: 2 }] } },
  { a: { b: [1, { c: 3 }] } },
  Object.create(null),
];

describe('the browser stand-in for node:assert/strict', () => {
  it('agrees with Node on equal, notEqual and deepEqual over every pair of values', () => {
    for (const a of VALUES) {
      for (const b of VALUES) {
        const label = `${JSON.stringify(a)} against ${JSON.stringify(b)}`;
        expect(
          throws(() => shim.equal(a, b)),
          `equal ${label}`,
        ).toBe(throws(() => nodeAssert.equal(a, b)));
        expect(
          throws(() => shim.notEqual(a, b)),
          `notEqual ${label}`,
        ).toBe(throws(() => nodeAssert.notEqual(a, b)));
        expect(
          throws(() => shim.deepEqual(a, b)),
          `deepEqual ${label}`,
        ).toBe(throws(() => nodeAssert.deepEqual(a, b)));
      }
    }
  });

  it('agrees with Node on which values are truthy', () => {
    for (const value of VALUES) {
      expect(
        throws(() => shim.ok(value)),
        JSON.stringify(value),
      ).toBe(throws(() => nodeAssert.ok(value)));
      expect(
        throws(() => shim(value)),
        JSON.stringify(value),
      ).toBe(throws(() => nodeAssert(value)));
    }
  });

  it('reports the message it is given, and throws an Error it is given as it is', () => {
    expect(() => shim.ok(false, 'the reason')).toThrow('the reason');
    expect(() => shim.equal(1, 2, 'the reason')).toThrow('the reason');
    const mine = new RangeError('mine');
    expect(() => shim.deepEqual(1, 2, mine)).toThrow(mine);
  });

  it('refuses a value it cannot compare rather than calling it equal', () => {
    expect(() => shim.deepEqual(new Map([[1, 2]]), new Map([[3, 4]]))).toThrow(TypeError);
    expect(() => shim.deepEqual(new Date(0), new Date(1))).toThrow(TypeError);
    expect(() => shim.deepEqual(new Set([1]), new Set([2]))).toThrow(TypeError);
  });
});

describe('the browser stand-in for node:timers/promises', () => {
  it('resolves with nothing after the delay', async () => {
    const started = Date.now();
    await expect(shimDelay(30)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});

describe('the built web suite', () => {
  const file = fileURLToPath(new URL('../dist/test-web/suite.js', import.meta.url));

  it('is built, exports run, and requires nothing but vscode', () => {
    expect(existsSync(file), 'run `npm run build` first').toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/\brun\b/);
    const required = [...text.matchAll(/\brequire\(["']([^"']+)["']\)/g)].map((m) => m[1]);
    expect(new Set(required)).toEqual(new Set(['vscode']));
    expect(text).not.toMatch(/["']node:/);
  });
});
