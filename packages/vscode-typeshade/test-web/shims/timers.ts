// === `node:timers/promises`, for a browser ===
//
// The one call the shared plugin cases make is `setTimeout(ms)`, awaited. `scripts/build.mjs`
// bundles the web suite with this file in place of the Node module, for the reason
// `assert.ts` gives.

/**
 * Resolves after `ms` milliseconds, as `node:timers/promises`' `setTimeout` does.
 *
 * @param ms - how long to wait.
 * @returns a promise that resolves with nothing.
 */
export function setTimeout(ms?: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}
