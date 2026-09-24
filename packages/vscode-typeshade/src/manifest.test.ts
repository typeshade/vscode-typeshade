// The manifest is the one part of an extension nothing else can check: a command with a typo in
// its id registers fine and never appears, and a missing `enableForWorkspaceTypeScriptVersions`
// makes the plugin silently do nothing in every repository that pins its own TypeScript. These
// assertions are `docs/design.md` §4's two tables, written out.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Manifest {
  activationEvents: string[];
  engines: Record<string, string>;
  main: string;
  contributes: {
    typescriptServerPlugins: { name: string; enableForWorkspaceTypeScriptVersions?: boolean }[];
    commands: { command: string; title: string }[];
    menus: { commandPalette: { command: string; when: string }[] };
    configuration: { properties: Record<string, { type: string; default: unknown }> };
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')) as Manifest;

describe('the extension manifest', () => {
  it('contributes the plugin, for the workspace TypeScript too', () => {
    // Without the second flag the plugin loads only under VS Code's bundled TypeScript, and a
    // repository that pins its own (which every repository with a `.shade.ts` file in it does)
    // would get nothing, with no error anywhere.
    expect(manifest.contributes.typescriptServerPlugins).toEqual([
      { name: '@typeshade/tsserver-plugin', enableForWorkspaceTypeScriptVersions: true },
    ]);
  });

  it('activates on TypeScript and on nothing else', () => {
    // No `workspaceContains:**/*.shade.ts`: it would fire the extension in projects that have
    // shaders but no open shader, for no benefit. Commands activate implicitly from 1.74.
    expect(manifest.activationEvents).toEqual(['onLanguage:typescript']);
    expect(manifest.engines.vscode).toBe('^1.90.0');
  });

  it("declares §4's five commands, with §4's titles", () => {
    expect(manifest.contributes.commands).toEqual([
      { command: 'typeshade.showWgsl', title: 'TypeShade: Show WGSL' },
      { command: 'typeshade.showGlsl', title: 'TypeShade: Show GLSL' },
      { command: 'typeshade.showReflection', title: 'TypeShade: Show Reflection' },
      { command: 'typeshade.runEntry', title: 'TypeShade: Run Entry on CPU' },
      { command: 'typeshade.copyOutput', title: 'TypeShade: Copy Output' },
    ]);
  });

  it('hides every command in the palette unless the file is a shader', () => {
    // §4: "Every command is enabled only when the active editor's file carries the directive."
    // A command missing from this list is one that shows up in every TypeScript project.
    const gated = new Map(
      manifest.contributes.menus.commandPalette.map((entry) => [entry.command, entry.when]),
    );
    for (const { command } of manifest.contributes.commands) {
      expect(gated.get(command)).toBe('typeshade.isShader');
    }
  });

  it("declares §4's five settings, with §4's defaults", () => {
    const properties = manifest.contributes.configuration.properties;
    expect(
      Object.fromEntries(
        Object.entries(properties).map(([name, schema]) => [name, schema.default]),
      ),
    ).toEqual({
      'typeshade.preview.autoUpdate': true,
      'typeshade.preview.debounceMs': 300,
      'typeshade.diagnostics.replace': true,
      'typeshade.debug.precision': 'f32',
      'typeshade.trace.server': 'off',
    });
    expect(properties['typeshade.preview.debounceMs'].type).toBe('number');
    expect(properties['typeshade.diagnostics.replace'].type).toBe('boolean');
  });

  it('points at the bundle the build writes, not at a source file', () => {
    expect(manifest.main).toBe('./dist/extension.js');
  });
});
