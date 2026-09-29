// The web entry is the one bundle that must run where there is nothing of Node, so what it must
// not carry is asserted on the file the build wrote (`npm run build` runs first in `npm run
// check`), and what it does is asserted by running that file in a `vm` realm that has none of
// Node's globals, with a fake `vscode`. A stub that quietly reached for `Buffer` would build,
// type-check (the package's `tsc` has Node's types) and fail only in a browser worker.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, '..', 'dist', 'web', 'extension.js');
const MANIFEST = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')) as {
  contributes: { commands: { command: string }[] };
};
const COMMAND_IDS = MANIFEST.contributes.commands.map(({ command }) => command);

/** The bundle is a stub over `vscode`, a few KB; the desktop one carries the compiler and is
 *  over 11 MB. A bound between them says which one this is. */
const SIZE_LIMIT = 32 * 1024;

describe('the web extension bundle, as a file', () => {
  it('is built and small', () => {
    expect(existsSync(BUNDLE), `${BUNDLE} is missing; run npm run build`).toBe(true);
    expect(statSync(BUNDLE).size).toBeLessThan(SIZE_LIMIT);
  });

  it('requires `vscode` and nothing else, and names nothing of Node', () => {
    const text = readFileSync(BUNDLE, 'utf8');
    const required = [...text.matchAll(/\brequire\(\s*(["'])(.*?)\1\s*\)/g)].map(
      (match) => match[2],
    );
    expect([...new Set(required)]).toEqual(['vscode']);
    expect(text).not.toMatch(/node:/);
    expect(text).not.toMatch(/\bBuffer\b/);
    expect(text).not.toMatch(/\bprocess\b/);
    for (const builtin of ['fs', 'zlib', 'path', 'os', 'child_process']) {
      expect(text, builtin).not.toContain(`"${builtin}"`);
      expect(text, builtin).not.toContain(`'${builtin}'`);
    }
    // The web extension host runs the file as `new Function('module', 'exports', 'require',
    // text)`, so it is CommonJS with no module syntax at the top level.
    expect(text).not.toMatch(/^(import|export) /m);
    expect(text).toMatch(/exports/);
  });
});

interface Shown {
  readonly kind: 'information' | 'warning';
  readonly text: string;
}

/** A `vscode` with only what the entry uses, recording what it is asked to do. */
function fakeVscode(version: string) {
  const handlers = new Map<string, () => unknown>();
  const shown: Shown[] = [];
  const api = {
    version,
    commands: {
      registerCommand(id: string, handler: () => unknown) {
        if (handlers.has(id)) throw new Error(`command ${id} registered twice`);
        handlers.set(id, handler);
        return { dispose: () => handlers.delete(id) };
      },
    },
    window: {
      showInformationMessage(text: string) {
        shown.push({ kind: 'information', text });
        // A message resolves when the user closes it; this one never does, as on a real page.
        return new Promise<never>(() => undefined);
      },
      showWarningMessage(text: string) {
        shown.push({ kind: 'warning', text });
        return new Promise<never>(() => undefined);
      },
    },
  };
  return { api, handlers, shown };
}

interface Activated {
  readonly web: { isolated: boolean; supported: boolean; notice: string | undefined };
}

/** Loads the bundle the way the web extension host does, in a realm with no Node globals, and
 *  activates it. */
function activateInRealm(options: { isolated: boolean | undefined; version: string }) {
  const vscode = fakeVscode(options.version);
  const sandbox: Record<string, unknown> = {};
  if (options.isolated !== undefined) sandbox.crossOriginIsolated = options.isolated;
  const realm = createContext(sandbox);
  const globalsLeft = runInContext(
    `['process', 'Buffer', 'require', 'module', 'setImmediate', 'global'].filter((name) => typeof globalThis[name] !== 'undefined').join()`,
    realm,
  ) as string;

  const wrapper = runInContext(
    `(function (module, exports, require) {${readFileSync(BUNDLE, 'utf8')}\n})`,
    realm,
    { filename: BUNDLE },
  ) as (module: { exports: unknown }, exports: unknown, require: (id: string) => unknown) => void;
  const module: { exports: { activate?: (context: unknown) => unknown } } = { exports: {} };
  const requested: string[] = [];
  wrapper(module, module.exports, (id) => {
    requested.push(id);
    if (id !== 'vscode') throw new Error(`Cannot find module '${id}'`);
    return vscode.api;
  });

  const subscriptions: { dispose(): void }[] = [];
  const context = {
    subscriptions,
    extension: { packageJSON: MANIFEST },
  };
  expect(typeof module.exports.activate).toBe('function');
  const result = module.exports.activate?.(context) as Activated;
  return { ...vscode, subscriptions, requested, globalsLeft, result };
}

const STUB_TEXT = /need the desktop version/;

describe('the web extension bundle, activated in a realm with no Node globals', () => {
  it('has none of process, Buffer, require, module, setImmediate or global to lean on', () => {
    const { globalsLeft } = activateInRealm({ isolated: true, version: '1.139.1' });
    expect(globalsLeft).toBe('');
  });

  it("registers every command of the manifest, and only the manifest's", () => {
    const { handlers, subscriptions, requested } = activateInRealm({
      isolated: true,
      version: '1.139.1',
    });
    expect([...handlers.keys()]).toEqual(COMMAND_IDS);
    expect(subscriptions).toHaveLength(COMMAND_IDS.length);
    expect(new Set(requested)).toEqual(new Set(['vscode']));
  });

  it('answers each command with a message that says what needs the desktop, and does not wait', () => {
    const { handlers, shown } = activateInRealm({ isolated: true, version: '1.139.1' });
    expect(shown).toEqual([]);
    for (const id of COMMAND_IDS) {
      const before = shown.length;
      // A handler that returned the message's promise would never settle here.
      expect(handlers.get(id)?.(), id).toBeUndefined();
      expect(shown.length, id).toBe(before + 1);
      expect(shown[before].kind).toBe('information');
      expect(shown[before].text).toMatch(STUB_TEXT);
      expect(shown[before].text).toContain('diagnostics, hover and imports between shader files');
    }
  });

  it('says nothing at activation on an isolated page of a supported VS Code', () => {
    const { shown, result } = activateInRealm({ isolated: true, version: '1.139.1' });
    expect(shown).toEqual([]);
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      web: { isolated: true, supported: true },
    });
  });

  it.each([
    { isolated: false, version: '1.139.1', supported: true, pattern: /not cross-origin isolated/ },
    { isolated: true, version: '1.109.0', supported: false, pattern: /needs 1\.110\.0 or later/ },
    { isolated: false, version: '1.109.0', supported: false, pattern: /needs 1\.110\.0 or later/ },
  ])(
    'warns once, and reports it, for isolated=$isolated on $version',
    ({ isolated, version, supported, pattern }) => {
      const { shown, result } = activateInRealm({ isolated, version });
      expect(shown).toHaveLength(1);
      expect(shown[0].kind).toBe('warning');
      expect(shown[0].text).toMatch(pattern);
      expect(result.web.isolated).toBe(isolated);
      expect(result.web.supported).toBe(supported);
      expect(result.web.notice).toBe(shown[0].text);
    },
  );

  it('reads a page that does not say as not isolated', () => {
    const { result, shown } = activateInRealm({ isolated: undefined, version: '1.139.1' });
    expect(result.web.isolated).toBe(false);
    expect(shown).toHaveLength(1);
  });
});
