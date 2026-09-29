// === The three cases that say the TypeScript server plugin loaded and answered ===
//
// The plugin is the one part of this extension that is not extension code, and the only thing
// that loads it is the manifest's `typescriptServerPlugins` entry, so no unit test can show that
// it ran. A real host can: the desktop's (`test-electron/suite.ts`) and VS Code for the Web's
// (`test-web/suite.ts`) both run these, so the two platforms are held to one set of assertions
// about the same fixture files, not to two sets that can drift apart.
//
// The file imports `vscode` and `assert` and nothing else. `node:assert/strict` and
// `node:timers/promises` are Node's; the web suite is bundled with two small stand-ins for them
// (`test-web/shims/`), which is why nothing beyond `ok`, `equal`, `notEqual` and `deepEqual` from
// one and `setTimeout` from the other may be used here.

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';
import type { Register } from './harness.js';

/** How long an empty diagnostics list must hold before it is believed. */
const SETTLE_MS = 5_000;

/**
 * Registers the three plugin cases, in the order they must run.
 *
 * @param test - the suite's `test`.
 */
export function registerPluginCases(test: Register): void {
  test('TypeScript itself is answering, which is what makes the next case mean anything', async () => {
    // The control. Without it the next case passes on a host where no language server ran at all:
    // "no diagnostic carries the source `ts`" is true of an empty list. This file has a real
    // TypeScript error, so TS2322 arriving proves the TypeScript extension is alive and reporting
    // in this window before anything is claimed about a shader.
    const document = await open('broken-ts.ts');
    const diagnostics = await waitFor(() => {
      const current = vscode.languages.getDiagnostics(document.uri);
      return current.length > 0 ? current : undefined;
    }, 60_000);
    assert.ok(diagnostics, 'TypeScript reported nothing on a file with a real type error');
    assert.deepEqual(
      diagnostics.map((d) => d.code),
      [2322],
    );
  });

  test('the server plugin replaces TypeScript answers on a shader', async () => {
    // The assertion only a real host can make, and the reason this suite exists at all: the
    // manifest's `typescriptServerPlugins` entry is the only thing that loads the plugin, and
    // nothing in vitest can prove it worked. Without it this file reports TS1206 on `@fragment`
    // and TS2304 on `f32` and `vec4`, which is the false-positive case
    // `docs/measurements/two-program-cost/` measured 58 of across the compiler's six examples.
    const document = await open('hello.shade.ts');
    const reported = (): string =>
      JSON.stringify(
        vscode.languages
          .getDiagnostics(document.uri)
          .map((d) => `${d.source ?? ''}:${String(d.code)}`),
      );
    const diagnostics = await waitFor(() => {
      const current = vscode.languages.getDiagnostics(document.uri);
      return current.length === 0 ? current : undefined;
    }, 60_000);
    assert.ok(diagnostics, `a clean shader still reports ${reported()}`);
    // An empty list is also what a file has before any server has looked at it, and in the web
    // host, where this is the first time the file is opened, that is the state the poll above
    // sees first: it passed with the plugin removed. So the list has to STAY empty while
    // TypeScript's own report on the file would have had time to arrive. This is the second guard
    // and not the first: the case after this one is the positive one.
    await delay(SETTLE_MS);
    assert.equal(
      vscode.languages.getDiagnostics(document.uri).length,
      0,
      `a clean shader reported ${reported()} after ${SETTLE_MS} ms`,
    );
  });

  test('a real TypeShade error reaches the Problems view as TypeShade', async () => {
    // Silence proves the plugin suppressed something; this proves it ANSWERED. A regression that
    // turned the plugin into a mute would pass the case above and fail this one.
    const document = await open('broken.shade.ts');
    const diagnostics = await waitFor(() => {
      const current = vscode.languages.getDiagnostics(document.uri);
      return current.some((d) => d.source === 'typeshade') ? current : undefined;
    }, 60_000);
    assert.ok(diagnostics, 'no diagnostic from the TypeShade program arrived');
    const own = diagnostics.filter((d) => d.source === 'typeshade');
    assert.deepEqual(
      own.map((d) => d.code),
      [8004],
    );
    assert.ok(own[0].message.includes('Unknown function'));
    // TS1206 on the decorator and TS2304 on `f32` are gone, which is the replacement itself.
    assert.deepEqual(
      diagnostics.filter((d) => d.code === 1206),
      [],
    );
  });
}

/** Opens a fixture file in the test workspace and shows it. */
export async function open(name: string): Promise<vscode.TextDocument> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the test host opened no workspace folder');
  const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, name));
  await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
  return document;
}

/** Polls `probe` until it answers with something, or gives up.
 *
 *  Everything a language server does is asynchronous and unannounced: there is no event for
 *  "tsserver has finished loading its plugins", so a suite that asserts on diagnostics has to
 *  wait for them to settle. */
export async function waitFor<T>(probe: () => T | undefined, ms = 10_000): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) return undefined;
    await delay(250);
  }
}
