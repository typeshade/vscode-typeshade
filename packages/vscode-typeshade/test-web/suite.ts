// === The suite that runs INSIDE VS Code for the Web ===
//
// `docs/playground-bridge.md` §4: on the web the extension is a stub, and what a shader author
// gets (diagnostics, hover, completion, navigation) comes from the TypeScript server plugin that
// the web extension host loads from the plugin package's `browser` field. Nothing in vitest can
// show that the host did load it, or that the plugin answered from inside a worker with no Node,
// so this suite does, in the browser build of VS Code that `@vscode/test-web` serves.
//
// It has two halves. What every page must do, isolated or not: the extension activates and says
// what it found, and every command the manifest contributes is registered and does not throw.
// What only a cross-origin isolated page on VS Code 1.110 or later can do: run the plugin. That
// half runs the cases the electron suite runs (`test-shared/plugin-cases.ts`), then hover and an
// import between two shaders, and elsewhere it is reported as skipped, with the reason, so a run
// that never exercised the plugin cannot look like one that did.
//
// The page's isolation is not taken from the page alone. `scripts/test-web.mjs` writes what it
// asked for into `expect.json` in the workspace, and the first case fails when the page disagrees:
// otherwise a `--coi` that stopped working would turn every run into the degraded half and pass.
//
// Bundled for a browser with `vscode` external and two small stand-ins for Node's `assert` and
// `timers/promises` (`scripts/build.mjs`, `test-web/shims/`).

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import * as vscode from 'vscode';
import type { TypeshadeWebApi } from '../src/web-support.js';
import { createSuite, Skip } from '../test-shared/harness.js';
import { open, registerPluginCases, waitFor } from '../test-shared/plugin-cases.js';

/** The extension's id, as the Marketplace will address it: publisher, then name. */
const EXTENSION_ID = 'typeshade.vscode-typeshade';

const { test, run } = createSuite();

/** What the runner asked the page for. */
interface Expected {
  readonly coi: boolean;
}

/** Reads `expect.json`, which the runner writes into the workspace beside the fixtures. */
async function expected(): Promise<Expected> {
  const document = await open('expect.json');
  return JSON.parse(document.getText()) as Expected;
}

/** Activates the extension and returns what its web entry reports about the page. */
async function activate(): Promise<TypeshadeWebApi> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(
    extension,
    `${EXTENSION_ID} is not installed in this web host: without a "browser" entry in its manifest ` +
      'the host does not load the extension at all',
  );
  const api = (await extension.activate()) as TypeshadeWebApi | undefined;
  assert.ok(api && typeof api === 'object' && api.web, 'the web entry returned no environment');
  return api;
}

/** `major.minor` of `vscode.version`, read here on its own so the entry's reading of it is checked
 *  against something that is not the entry. */
function versionOf(version: string): [number, number] {
  const match = /^(\d+)\.(\d+)\./.exec(version);
  assert.ok(match, `vscode.version is not a version: ${version}`);
  return [Number(match[1]), Number(match[2])];
}

/** Whether this host is new enough to load the plugin, by the same rule written out again. */
function hostLoadsPlugin(): boolean {
  const [major, minor] = versionOf(vscode.version);
  return major > 1 || (major === 1 && minor >= 110);
}

/**
 * Registers `body` so that it runs only where the plugin can answer.
 *
 * @param name - the case's name.
 * @param body - the case.
 */
function pluginTest(name: string, body: () => Promise<void>): void {
  test(name, async () => {
    const api = await activate();
    if (!api.web.supported) throw new Skip(`VS Code ${vscode.version} does not load the plugin`);
    if (!api.web.isolated) throw new Skip('the page is not cross-origin isolated');
    await body();
  });
}

test('activates in the web host, and reports the page it runs in', async () => {
  assert.equal(vscode.env.uiKind, vscode.UIKind.Web, 'this is not a web host');
  const api = await activate();
  const want = await expected();

  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
  assert.equal(isolated, want.coi, 'the page is not as isolated as the runner asked it to be');
  assert.equal(api.web.isolated, isolated);
  assert.equal(api.web.supported, hostLoadsPlugin());

  // The one-time warning is there exactly when the plugin cannot answer, and says which reason.
  if (!hostLoadsPlugin()) {
    assert.ok(api.web.notice?.includes('needs 1.110.0 or later'), String(api.web.notice));
  } else if (!isolated) {
    assert.ok(api.web.notice?.includes('not cross-origin isolated'), String(api.web.notice));
  } else {
    assert.equal(api.web.notice, undefined);
  }
});

test('registers every command the manifest contributes, and a stub runs without failing', async () => {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed in this host`);
  await activate();
  const contributed = (
    extension.packageJSON as { contributes: { commands: { command: string }[] } }
  ).contributes.commands.map((entry) => entry.command);
  assert.ok(contributed.includes('typeshade.showWgsl'), 'the manifest lost its commands');

  const registered = new Set(await vscode.commands.getCommands(true));
  for (const command of contributed) {
    assert.ok(registered.has(command), `${command} is not registered`);
  }

  // A desktop-only command says so and opens nothing: no preview tab appears.
  await open('hello.shade.ts');
  const tabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).length;
  const before = tabs();
  await vscode.commands.executeCommand('typeshade.showWgsl');
  assert.equal(tabs(), before, 'a stubbed command opened a tab');
});

// The plugin cases the desktop runs, over the same fixture files. Each is skipped, and says why,
// on a page or a host where the plugin cannot answer.
registerPluginCases(pluginTest);

pluginTest('hover answers from the compiler, not from TypeScript', async () => {
  // At `vec4`, not at `tint`: TypeScript describes `tint` as `function tint(x: f32): f32` too,
  // printing the names it cannot resolve, so a hover there passes with the plugin removed. On
  // `vec4` TypeScript has only `any`, and the compiler describes the builtin.
  const document = await open('hello.shade.ts');
  const at = document.positionAt(document.getText().indexOf('vec4(tint') + 1);
  const hover = await hoverText(document.uri, at, 'vec4');
  assert.ok(hover.includes('vec4'), `hover said ${hover}`);
});

pluginTest(
  'a shader that imports another resolves the import and checks across the files',
  async () => {
    // Measured nowhere before this case: whether the plugin's reads through `serverHost` resolve an
    // import inside the isolated semantic server. The assertion is positive on purpose. "No
    // diagnostic" is what an import that never resolved and one that resolved both look like once a
    // server is silent, so this file carries a real mistake that only a resolved import can show:
    // `double(true)` passes a boolean to an `f32` parameter of a function in `lib.shade.ts`. If the
    // import did not resolve, TS8072 arrives instead and there is no TS8003 at all.
    const document = await open('a.shade.ts');
    const found = await waitFor(() => {
      const current = vscode.languages.getDiagnostics(document.uri);
      return current.some((d) => d.source === 'typeshade' && d.code === 8003) ? current : undefined;
    }, 60_000);
    const describe = (): string =>
      JSON.stringify(
        vscode.languages
          .getDiagnostics(document.uri)
          .map((d) => `${d.source ?? ''}:${String(d.code)} ${d.message}`),
      );
    assert.ok(found, `the mistake across the import never arrived; the file reports ${describe()}`);
    const unresolved = found.filter((d) => d.code === 8072 || d.code === 2307);
    assert.deepEqual(unresolved, [], `the import did not resolve: ${describe()}`);
    const own = found.filter((d) => d.source === 'typeshade');
    assert.deepEqual(
      own.map((d) => d.code),
      [8003],
      describe(),
    );
    assert.ok(own[0].message.includes('double'), own[0].message);

    // The hover on the imported name carries the signature declared in the other file, in
    // TypeScript's own alias form. What tells the plugin from its absence is the mistake above; the
    // hover shows the two files are one program.
    const at = document.positionAt(document.getText().indexOf('double(true)') + 1);
    const hover = await hoverText(document.uri, at, 'double(x: f32): f32');
    assert.ok(hover.includes('double(x: f32): f32'), `hover said ${hover}`);
  },
);

/** The text of every hover at a position, polled until it contains `wanted` or time runs out. */
async function hoverText(
  uri: vscode.Uri,
  position: vscode.Position,
  wanted: string,
): Promise<string> {
  const deadline = Date.now() + 60_000;
  let text = '';
  for (;;) {
    const hovers =
      (await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        uri,
        position,
      )) ?? [];
    text = hovers
      .flatMap((hover) => hover.contents)
      .map((content) => (typeof content === 'string' ? content : content.value))
      .join('\n');
    if (text.includes(wanted) || Date.now() > deadline) return text;
    await delay(250);
  }
}

export { run };
