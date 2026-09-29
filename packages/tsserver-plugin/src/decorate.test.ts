import { describe, expect, it, vi } from 'vitest';
import typescript from 'typescript';
import type ts from 'typescript';
import { createPlugin } from './index.js';
import { LIB, MAIN } from './fixtures.js';
import { testCreateInfo, testProject } from './testing.js';

const MANIFEST = '{ "name": "shade-lib", "exports": { "typeshade": "./lib.shade.ts" } }';
const PACKAGE_JSON = '/p/node_modules/shade-lib/package.json';

/** A project whose importer names a package, so resolving it makes the plugin read that
 *  package's `package.json`, which is the read `readFrom` chooses a source for. The two readers
 *  are spies that both know the manifest, so a test can say which one was asked. */
function setup() {
  const project = testProject({
    [PACKAGE_JSON]: MANIFEST,
    '/p/node_modules/shade-lib/lib.shade.ts': LIB,
    '/p/main.shade.ts': MAIN.replace('./lib.shade.js', 'shade-lib'),
  });
  const hostRead = vi.fn((fileName: string) => project.host.readFile?.(fileName));
  const serverRead = vi.fn((fileName: string) => project.host.readFile?.(fileName));
  const snapshots = vi.fn((fileName: string) => project.host.getScriptSnapshot(fileName));
  const versions = vi.fn((fileName: string) => project.host.getScriptVersion(fileName));
  const names = vi.fn(() => project.host.getScriptFileNames());
  const { info, logged } = testCreateInfo(project);
  const wired = {
    ...info,
    languageServiceHost: {
      ...project.host,
      readFile: hostRead,
      getScriptSnapshot: snapshots,
      getScriptVersion: versions,
      getScriptFileNames: names,
    },
    serverHost: { readFile: serverRead },
  } as unknown as ts.server.PluginCreateInfo;
  return { project, wired, logged, hostRead, serverRead, snapshots, versions, names };
}

function readsOf(spy: ReturnType<typeof vi.fn>): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

describe('where the plugin reads a package.json from', () => {
  it('reads through languageServiceHost by default, which is the desktop path', () => {
    const { wired, hostRead, serverRead, snapshots, versions, names } = setup();
    const service = createPlugin({ typescript }).create(wired);
    expect(service.getSemanticDiagnostics('/p/main.shade.ts')).toEqual([]);
    expect(readsOf(hostRead)).toContain(PACKAGE_JSON);
    expect(serverRead).not.toHaveBeenCalled();
    expect(snapshots).toHaveBeenCalled();
    expect(versions).toHaveBeenCalled();
    expect(names).toHaveBeenCalled();
  });

  it('reads through serverHost when the entry asks for it, and only for readFile', () => {
    const { wired, hostRead, serverRead, snapshots, versions, names } = setup();
    const service = createPlugin({ typescript }, { readFrom: 'serverHost' }).create(wired);
    // The import resolves through the server's reader, so the answer is the same clean one.
    expect(service.getSemanticDiagnostics('/p/main.shade.ts')).toEqual([]);
    expect(readsOf(serverRead)).toContain(PACKAGE_JSON);
    expect(readsOf(hostRead)).not.toContain(PACKAGE_JSON);
    // `serverHost` has no counterpart for these three, so they keep coming from the language
    // service host in both cases.
    expect(snapshots).toHaveBeenCalled();
    expect(versions).toHaveBeenCalled();
    expect(names).toHaveBeenCalled();
  });

  it('serves whatever serverHost answers, not what the language service host would', () => {
    // The two readers differ here on purpose: the server's manifest points at a file that does
    // not exist, so the import stays unresolved only if the server's answer was the one used.
    const { wired } = setup();
    (wired as unknown as { serverHost: { readFile: () => string } }).serverHost.readFile = () =>
      '{ "name": "shade-lib", "exports": { "typeshade": "./missing.shade.ts" } }';
    const viaServer = createPlugin({ typescript }, { readFrom: 'serverHost' }).create(wired);
    const viaHost = createPlugin({ typescript }).create(setup().wired);
    expect(viaHost.getSemanticDiagnostics('/p/main.shade.ts')).toEqual([]);
    expect(viaServer.getSemanticDiagnostics('/p/main.shade.ts')).not.toEqual([]);
  });

  it('logs that it loaded, as before', () => {
    const { wired, logged } = setup();
    createPlugin({ typescript }, { readFrom: 'serverHost' }).create(wired);
    expect(logged.some((line) => line.includes('plugin loaded'))).toBe(true);
  });
});

describe('the web entry', () => {
  it('has a default export that is a factory returning a plugin with create', async () => {
    // The web tsserver calls `(await import(url)).default`; a module with only a named export
    // makes that undefined and the plugin silently never loads.
    const web = await import('./web.js');
    expect(typeof web.default).toBe('function');
    const plugin = web.default({ typescript });
    expect(typeof plugin.create).toBe('function');
  });

  it('reads through serverHost', async () => {
    const web = await import('./web.js');
    const { wired, hostRead, serverRead } = setup();
    web.default({ typescript }).create(wired).getSemanticDiagnostics('/p/main.shade.ts');
    expect(readsOf(serverRead)).toContain(PACKAGE_JSON);
    expect(readsOf(hostRead)).not.toContain(PACKAGE_JSON);
  });
});
