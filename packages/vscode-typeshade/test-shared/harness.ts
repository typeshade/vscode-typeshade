// === The tiny runner both extension suites share ===
//
// The VS Code test runner asks an `extensionTestsPath` module for a `run()` and fails the run when
// it rejects, which is the whole of what a framework would add for suites this size. The electron
// suite (`test-electron/suite.ts`) and the web suite (`test-web/suite.ts`) each list their cases
// with `test()` and export the `run` this returns, so a failure reads the same in both.
//
// This file imports nothing: the electron suite is bundled for node and the web suite for a
// browser, and what they share has to load in both.

/** Thrown by a case that cannot say anything on this host, with the reason. A skipped case is
 *  reported as skipped and never as passed, so a run that skipped what it was for is visible. */
export class Skip extends Error {}

/** One case. */
interface Case {
  readonly name: string;
  readonly body: () => Promise<void>;
}

/** Registers a case. */
export type Register = (name: string, body: () => Promise<void>) => void;

/**
 * A suite: the `test` that adds a case to it and the `run` that runs them in order.
 *
 * @returns both functions, over one list of cases.
 */
export function createSuite(): { test: Register; run: () => Promise<void> } {
  const cases: Case[] = [];

  /** Registers a case. */
  const test: Register = (name, body) => {
    cases.push({ name, body });
  };

  /**
   * Runs every case. The VS Code test runner fails the run when this rejects.
   *
   * @returns nothing, or rejects with every failure at once.
   */
  const run = async (): Promise<void> => {
    const failures: string[] = [];
    let skipped = 0;
    for (const one of cases) {
      try {
        await one.body();
        console.log(`  ok  ${one.name}`);
      } catch (error) {
        if (error instanceof Skip) {
          skipped++;
          console.log(`skip  ${one.name} (${error.message})`);
          continue;
        }
        failures.push(`${one.name}: ${error instanceof Error ? error.message : String(error)}`);
        console.log(`FAIL  ${one.name}`);
      }
    }
    const passed = cases.length - failures.length - skipped;
    console.log(`${passed}/${cases.length} passed${skipped > 0 ? `, ${skipped} skipped` : ''}`);
    if (failures.length > 0) throw new Error(`\n${failures.join('\n')}`);
  };

  return { test, run };
}
