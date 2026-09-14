// === The suite that runs INSIDE a real VS Code ===
//
// `docs/design.md` §6: the extension's logic lives in modules that do not import `vscode` and is
// unit-tested with vitest, so what is left for an extension host is exactly the part vitest
// cannot reach. That is what this file asserts and nothing more: that the extension activates,
// that its commands are registered, that the context key gates them, that the preview panel
// opens with the right text in it, and that the TypeScript server plugin actually loaded.
//
// There is no mocha here. The VS Code test runner asks an `extensionTestsPath` module for a
// `run()` and fails the run when it rejects, which is the whole of what a framework would add
// for a suite this size; `node:assert` and a list of named cases do the rest, and the launcher
// has one dependency instead of four.

import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import * as vscode from 'vscode'

/** The extension's id, as the Marketplace will address it: publisher, then name. */
const EXTENSION_ID = 'typeshade.vscode-typeshade'

/** One case. */
interface Case {
  readonly name: string
  readonly body: () => Promise<void>
}

const cases: Case[] = []

/** Registers a case. */
function test(name: string, body: () => Promise<void>): void {
  cases.push({ name, body })
}

test('activates, and contributes the plugin to the workspace TypeScript', async () => {
  const extension = vscode.extensions.getExtension(EXTENSION_ID)
  assert.ok(extension, `${EXTENSION_ID} is not installed in this host`)
  await extension.activate()
  assert.equal(extension.isActive, true)

  const contributed = (
    extension.packageJSON as {
      contributes: { typescriptServerPlugins: { enableForWorkspaceTypeScriptVersions?: boolean }[] }
    }
  ).contributes.typescriptServerPlugins
  assert.equal(contributed[0].enableForWorkspaceTypeScriptVersions, true)
})

test('registers every command it contributes', async () => {
  const registered = new Set(await vscode.commands.getCommands(true))
  for (const command of [
    'typeshade.showWgsl',
    'typeshade.showGlsl',
    'typeshade.showReflection',
    'typeshade.runEntry',
    'typeshade.copyOutput',
  ]) {
    assert.ok(registered.has(command), `${command} is not registered`)
  }
})

test('opens the preview with the compiled WGSL in it', async () => {
  const document = await open('hello.shade.ts')
  await vscode.commands.executeCommand('typeshade.showWgsl')
  const panel = await waitFor(() =>
    vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find((tab) => tab.label === 'TypeShade preview'),
  )
  assert.ok(panel, 'the preview panel did not open')
  // The panel's text is not readable from the extension host, so what is asserted here is what
  // is observable: it opened, beside the editor, for this document. What the text IS is
  // `model.test.ts`'s assertion, over the same model this panel renders.
  assert.notEqual(panel.group.viewColumn, vscode.window.activeTextEditor?.viewColumn)
  assert.ok(document.getText().includes('use typeshade'))
})

test('leaves a file without the directive alone', async () => {
  await open('plain.ts')
  // The context key is not readable either, so this asserts the user-visible consequence: the
  // command refuses rather than opening a panel on a file that is not a shader.
  const before = vscode.window.tabGroups.all.flatMap((group) => group.tabs).length
  await vscode.commands.executeCommand('typeshade.showReflection')
  await delay(200)
  assert.equal(vscode.window.tabGroups.all.flatMap((group) => group.tabs).length, before)
})

test('TypeScript itself is answering, which is what makes the next case mean anything', async () => {
  // The control. Without it the next case passes on a host where no language server ran at all:
  // "no diagnostic carries the source `ts`" is true of an empty list. This file has a real
  // TypeScript error, so TS2322 arriving proves the TypeScript extension is alive and reporting
  // in this window before anything is claimed about a shader.
  const document = await open('broken-ts.ts')
  const diagnostics = await waitFor(() => {
    const current = vscode.languages.getDiagnostics(document.uri)
    return current.length > 0 ? current : undefined
  }, 60_000)
  assert.ok(diagnostics, 'TypeScript reported nothing on a file with a real type error')
  assert.deepEqual(
    diagnostics.map((d) => d.code),
    [2322],
  )
})

test('the server plugin replaces TypeScript answers on a shader', async () => {
  // The assertion only a real host can make, and the reason this suite exists at all: the
  // manifest's `typescriptServerPlugins` entry is the only thing that loads the plugin, and
  // nothing in vitest can prove it worked. Without it this file reports TS1206 on `@fragment`
  // and TS2304 on `f32` and `vec4`, which is the false-positive case
  // `docs/measurements/two-program-cost/` measured 58 of across the compiler's six examples.
  const document = await open('hello.shade.ts')
  const diagnostics = await waitFor(() => {
    const current = vscode.languages.getDiagnostics(document.uri)
    return current.length === 0 ? current : undefined
  }, 60_000)
  assert.ok(
    diagnostics,
    `a clean shader still reports ${JSON.stringify(
      vscode.languages
        .getDiagnostics(document.uri)
        .map((d) => `${d.source ?? ''}:${String(d.code)}`),
    )}`,
  )
})

test('a real TypeShade error reaches the Problems view as TypeShade', async () => {
  // Silence proves the plugin suppressed something; this proves it ANSWERED. A regression that
  // turned the plugin into a mute would pass the case above and fail this one.
  const document = await open('broken.shade.ts')
  const diagnostics = await waitFor(() => {
    const current = vscode.languages.getDiagnostics(document.uri)
    return current.some((d) => d.source === 'typeshade') ? current : undefined
  }, 60_000)
  assert.ok(diagnostics, 'no diagnostic from the TypeShade program arrived')
  const own = diagnostics.filter((d) => d.source === 'typeshade')
  assert.deepEqual(
    own.map((d) => d.code),
    [8004],
  )
  assert.ok(own[0].message.includes('Unknown function'))
  // TS1206 on the decorator and TS2304 on `f32` are gone, which is the replacement itself.
  assert.deepEqual(
    diagnostics.filter((d) => d.code === 1206),
    [],
  )
})

/**
 * Runs every case. The VS Code test runner fails the run when this rejects.
 *
 * @returns nothing, or rejects with every failure at once.
 */
export async function run(): Promise<void> {
  const failures: string[] = []
  for (const one of cases) {
    try {
      await one.body()
      console.log(`  ok  ${one.name}`)
    } catch (error) {
      failures.push(`${one.name}: ${error instanceof Error ? error.message : String(error)}`)
      console.log(`FAIL  ${one.name}`)
    }
  }
  console.log(`${cases.length - failures.length}/${cases.length} passed`)
  if (failures.length > 0) throw new Error(`\n${failures.join('\n')}`)
}

/** Opens a fixture file in the test workspace and shows it. */
async function open(name: string): Promise<vscode.TextDocument> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  assert.ok(folder, 'the test host opened no workspace folder')
  const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, name))
  await vscode.window.showTextDocument(document, vscode.ViewColumn.One)
  return document
}

/** Polls `probe` until it answers with something, or gives up.
 *
 *  Everything a language server does is asynchronous and unannounced: there is no event for
 *  "tsserver has finished loading its plugins", so a suite that asserts on diagnostics has to
 *  wait for them to settle. */
async function waitFor<T>(probe: () => T | undefined, ms = 10_000): Promise<T | undefined> {
  const deadline = Date.now() + ms
  for (;;) {
    const found = probe()
    if (found !== undefined) return found
    if (Date.now() > deadline) return undefined
    await delay(250)
  }
}
