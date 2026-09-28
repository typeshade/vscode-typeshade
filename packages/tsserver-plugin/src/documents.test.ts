import { describe, expect, it } from 'vitest';
import typescript from 'typescript';
import { createTypeshadeLanguageService } from './compiler.js';
import { DocumentSync } from './documents.js';
import { CLEAN, CLEAN_WITHOUT_DIRECTIVE, LIB, MAIN } from './fixtures.js';
import { testProject } from './testing.js';

/** A sync over a project, with the service it feeds. */
function setup(files: Readonly<Record<string, string>>) {
  const project = testProject(files);
  let sync: DocumentSync | undefined;
  const shade = createTypeshadeLanguageService({ readDocument: (uri) => sync?.readDocument(uri) });
  sync = new DocumentSync(typescript, project.host, shade);
  return { project, shade, sync };
}

describe('document sync', () => {
  it('opens a shader and keeps it current', () => {
    const { project, shade, sync } = setup({ '/p/a.shade.ts': CLEAN });
    expect(sync.sync('/p/a.shade.ts', true)).toBe(true);
    expect(shade.getDiagnostics('/p/a.shade.ts')).toEqual([]);

    project.edit('/p/a.shade.ts', CLEAN.replace('x * 0.5', 'x * nope'));
    sync.sync('/p/a.shade.ts', true);
    expect(shade.getDiagnostics('/p/a.shade.ts').length).toBeGreaterThan(0);
  });

  it('closes a file that loses its directive, which nothing else can', () => {
    // The file is still a member of the project, so no prune reaches it: without this the
    // TypeShade program would hold a plain TypeScript file forever.
    const { shade, sync } = setup({ '/p/a.shade.ts': CLEAN });
    sync.sync('/p/a.shade.ts', true);
    expect(sync.openFileNames()).toEqual(['/p/a.shade.ts']);

    expect(sync.sync('/p/a.shade.ts', false)).toBe(false);
    expect(sync.openFileNames()).toEqual([]);
    expect(shade.getDiagnostics('/p/a.shade.ts')).toEqual([]);
  });

  it('drops a file the project no longer holds, on the next project version', () => {
    const { project, sync } = setup({ '/p/a.shade.ts': CLEAN, '/p/b.shade.ts': LIB });
    sync.sync('/p/a.shade.ts', true);
    sync.sync('/p/b.shade.ts', true);
    expect(sync.openFileNames()).toHaveLength(2);

    project.remove('/p/b.shade.ts');
    sync.sync('/p/a.shade.ts', true);
    expect(sync.openFileNames()).toEqual(['/p/a.shade.ts']);
  });

  it('serves an imported shader, and refuses one that is not a shader', () => {
    const { sync } = setup({
      '/p/lib.shade.ts': LIB,
      '/p/plain.ts': CLEAN_WITHOUT_DIRECTIVE,
    });
    expect(sync.readDocument('/p/lib.shade.ts')).toContain('use typeshade');
    // A plain TypeScript module is written for the standard library and the TypeShade program
    // has none, so pulling it in would report errors inside a file nobody asked to be a shader.
    expect(sync.readDocument('/p/plain.ts')).toBeUndefined();
    expect(sync.readDocument('/p/missing.shade.ts')).toBeUndefined();
  });

  it("serves a package's package.json through the host's reader, and never opens it", () => {
    // The compiler finds a package an import names by its `package.json` (its change 0024). The
    // sync hands it over as it is, and it stays out of the TypeShade program's documents.
    const manifest = '{ "name": "shade-lib", "exports": { "typeshade": "./lib.shade.ts" } }';
    const { shade, sync } = setup({
      '/p/node_modules/shade-lib/package.json': manifest,
      '/p/node_modules/shade-lib/lib.shade.ts': LIB,
      '/p/main.shade.ts': MAIN.replace('./lib.shade.js', 'shade-lib'),
    });
    expect(sync.readDocument('/p/node_modules/shade-lib/package.json')).toBe(manifest);
    sync.sync('/p/main.shade.ts', true);
    expect(codesFor(shade, '/p/main.shade.ts')).toEqual([]);
    sync.sync('/p/main.shade.ts', true);
    expect(sync.openFileNames()).toContain('/p/node_modules/shade-lib/lib.shade.ts');
    expect(sync.openFileNames()).not.toContain('/p/node_modules/shade-lib/package.json');
  });

  it('carries an edit to an imported shader into the importer, without being asked about it', () => {
    // The service's host caches a file pulled in through `readDocument` and never re-reads it,
    // so an edit to an imported shader would otherwise be invisible to the importer.
    //
    // The assertion is the importer's ANSWER, not the sync's own bookkeeping. An earlier version
    // of this test checked `openFileNames()`, which stayed true when `refreshOthers` walked only
    // the served set and the imported file was therefore frozen after one send: the name was
    // still in the list, the text behind it was stale, and the test passed either way. Reverting
    // that fix has to fail here.
    const { project, shade, sync } = setup({ '/p/main.shade.ts': MAIN, '/p/lib.shade.ts': LIB });
    sync.sync('/p/main.shade.ts', true);
    // Asking is what pulls the import in: the service resolves `./lib.shade.js` while it
    // analyses the importer, and `readDocument` is how it gets the text. The two files are one
    // program (the compiler's Rule 3.9), so the call to `double` resolves and nothing is wrong.
    expect(codesFor(shade, '/p/main.shade.ts')).toEqual([]);
    sync.sync('/p/main.shade.ts', true);
    expect(sync.openFileNames()).toContain('/p/lib.shade.ts');

    // Rename the export, and ask only about the importer. Nothing names `lib.shade.ts`. The
    // import is the compiler's TS8072, which keeps TypeScript's TS2305 for the same name out
    // (Rule 12.4).
    project.edit('/p/lib.shade.ts', LIB.replace('double', 'twice'));
    sync.sync('/p/main.shade.ts', true);
    expect(codesFor(shade, '/p/main.shade.ts')).toEqual(['TS8072']);

    project.edit('/p/lib.shade.ts', LIB);
    sync.sync('/p/main.shade.ts', true);
    expect(codesFor(shade, '/p/main.shade.ts')).toEqual([]);
  });

  it('serves a file again after its directive comes back', () => {
    // The close path clears `served` as well as `open`, so a file that loses its directive and
    // then regains it is not remembered as something the service already holds. The window this
    // leaves open is documented in `documents.ts`: while the directive is gone, an importer's
    // answer only refreshes once something names the imported file again.
    const { sync } = setup({ '/p/lib.shade.ts': LIB });
    expect(sync.readDocument('/p/lib.shade.ts')).toContain('use typeshade');
    sync.sync('/p/lib.shade.ts', false);
    expect(sync.openFileNames()).toEqual([]);
    expect(sync.readDocument('/p/lib.shade.ts')).toContain('use typeshade');
  });
});

/** The diagnostic codes on a document, TypeScript's as numbers and the compiler's as `TS8xxx`
 *  strings, for the assertions that read an answer rather than the sync's own bookkeeping. */
function codesFor(
  shade: ReturnType<typeof createTypeshadeLanguageService>,
  uri: string,
): (number | string)[] {
  return shade.getDiagnostics(uri).map((d) => d.code);
}
