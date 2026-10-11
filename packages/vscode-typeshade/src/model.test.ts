import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compile, compileModule, packModule, reflect } from './compiler.js';
import { PreviewModel, shaderReader } from './model.js';

const URI = 'file:///p/hello.shade.ts';

/** A shader with a vertex entry, a fragment entry and a struct, so every tab has something to
 *  show and the entry list has more than one row. */
const SHADER = `"use typeshade"

class VsOut {
  @builtin("position") pos: vec4
  @location(0) uv: vec2
}

@vertex
export function vs(@builtin("vertex_index") i: u32): VsOut {
  return { pos: vec4(f32(i), 0., 0., 1.), uv: vec2(0., 0.) }
}

@fragment
export function fs(input: VsOut): vec4 {
  return vec4(input.uv.x, 0., 0., 1.)
}
`;

/** The same shader mid-edit: the call is unfinished, which is a parse error. */
const BROKEN = SHADER.replace('vec4(input.uv.x, 0., 0., 1.)', 'vec4(input.uv.x, 0., 0.,');

function model(text = SHADER): PreviewModel {
  const created = new PreviewModel();
  created.setDocument(URI, text, 1);
  return created;
}

describe('the preview model', () => {
  it('compiles the three text tabs', () => {
    const preview = model();
    expect(preview.output(URI, 'wgsl')?.text).toContain('@vertex');
    expect(preview.output(URI, 'glsl-vertex')?.text).toContain('void main');
    expect(preview.output(URI, 'glsl-fragment')?.text).toContain('void main');
  });

  it('answers reflection as the JSON a reader can scroll', () => {
    const text = model().output(URI, 'reflection')?.text ?? '';
    // Parsed rather than matched, because the tab's whole value is that the structure is
    // readable: a string match would pass on a one-line dump.
    const reflection = JSON.parse(text) as { entries: { name: string; stage: string }[] };
    expect(reflection.entries.map((entry) => `${entry.stage} ${entry.name}`)).toEqual([
      'vertex vs',
      'fragment fs',
    ]);
    expect(text.split('\n').length).toBeGreaterThan(10);
  });

  it('shows the last output that compiled while the file is broken', () => {
    // This is §4's rule, and the reason it exists: a blank panel while you are mid-edit is worse
    // than a stale one that says it is stale.
    const preview = model();
    const good = preview.output(URI, 'wgsl')?.text ?? '';
    expect(good).toContain('@vertex');

    preview.setDocument(URI, BROKEN, 2);
    const during = preview.output(URI, 'wgsl');
    expect(during?.stale).toBe(true);
    expect(during?.text).toBe(good);
    expect(during?.diagnostics.some((d) => d.severity === 'error')).toBe(true);

    preview.setDocument(URI, SHADER, 3);
    expect(preview.output(URI, 'wgsl')?.stale).toBe(false);
  });

  it('has nothing to show for a file it never compiled', () => {
    const preview = model(BROKEN);
    const output = preview.output(URI, 'wgsl');
    expect(output?.text).toBe('');
    // Not stale: there is no previous output, and a panel that said "stale" with nothing behind
    // it would be claiming something it does not have.
    expect(output?.stale).toBe(false);
  });

  it('answers nothing at all for a document it does not hold', () => {
    expect(new PreviewModel().output(URI, 'wgsl')).toBeUndefined();
    expect(model().output('file:///p/other.shade.ts', 'wgsl')).toBeUndefined();
  });

  it('lists entries with the parameters the CPU oracle takes', () => {
    // From the declaration, not from `EntryInfo.io.inputs`: the reflection flattens `fs`'s struct
    // parameter into the struct's two fields, which does not line up with the one argument the
    // compiled function takes.
    const entries = model().entries(URI);
    expect(entries.map((entry) => entry.name)).toEqual(['vs', 'fs']);
    expect(entries[0].params.map((param) => param.name)).toEqual(['i']);
    expect(entries[1].params.map((param) => param.name)).toEqual(['input']);
    expect(entries[1].params[0].type).toEqual({ kind: 'struct', name: 'VsOut' });
  });

  it('lists no entries and offers no module while the file is broken', () => {
    const preview = model(BROKEN);
    expect(preview.entries(URI)).toEqual([]);
    expect(preview.module(URI)).toBeUndefined();
  });

  it('forgets everything about a closed document', () => {
    const preview = model();
    preview.output(URI, 'wgsl');
    preview.closeDocument(URI);
    expect(preview.has(URI)).toBe(false);
    expect(preview.output(URI, 'wgsl')).toBeUndefined();

    // Re-opened broken, the stale text from before the close must not come back: it belongs to a
    // document this model no longer has.
    preview.setDocument(URI, BROKEN, 1);
    expect(preview.output(URI, 'wgsl')?.stale).toBe(false);
  });

  it('shows an untitled editor, whose uri has no TypeScript extension', () => {
    // `untitled:Untitled-1` is how VS Code names a new editor. The service's TypeScript program
    // left such a root out, so every text tab answered nothing (vscode-typeshade#44's finding,
    // in the plugin).
    const untitled = 'untitled:Untitled-1';
    const preview = new PreviewModel();
    preview.setDocument(untitled, SHADER, 1);
    for (const tab of ['wgsl', 'glsl-vertex', 'glsl-fragment'] as const) {
      const output = preview.output(untitled, tab);
      expect(output?.diagnostics).toEqual([]);
      expect(output?.text).toBe(model().output(URI, tab)?.text);
    }
    expect(preview.entries(untitled).map((entry) => entry.name)).toEqual(['vs', 'fs']);
    // A diagnostic comes back under the editor's name, not the alias the service held it by.
    preview.setDocument(untitled, BROKEN, 2);
    const broken = preview.output(untitled, 'wgsl')?.diagnostics ?? [];
    expect(broken.length).toBeGreaterThan(0);
    expect(broken.every((d) => d.uri === untitled)).toBe(true);
  });
});

/** The compiler's examples, which the extension's own checks read from the pinned compiler. */
const EXAMPLES = new URL('../../../vendor/typeshade/examples/', import.meta.url);
const readFromDisk = (uri: string): string | undefined => {
  try {
    return readFileSync(fileURLToPath(uri), 'utf8');
  } catch {
    return undefined;
  }
};

describe("the preview's module is the one compile() builds", () => {
  // The model builds the module a reflection and a run read from the front end's result, and
  // built it with four of compile()'s fields: a reflection listed no override, a run could not
  // read one or a module's `var`, and a static-only class became a struct. `packModule` reads
  // every field, the WGSL and the layouts among them, so the two manifests differ where the two
  // modules do.
  const files = readdirSync(fileURLToPath(EXAMPLES)).filter((f) => f.endsWith('.shade.ts'));

  it('reads a corpus with an override in it (the instrument)', () => {
    expect(files.length).toBeGreaterThan(50);
    const overrides = files.filter((file) => {
      const uri = new URL(file, EXAMPLES).toString();
      const compiled = compile(readFromDisk(uri)!, { fileName: uri, readDocument: readFromDisk });
      return compiled.module !== undefined && reflect(compiled.module).overrides.length > 0;
    });
    expect(overrides.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(file, () => {
      const uri = new URL(file, EXAMPLES).toString();
      const text = readFromDisk(uri)!;
      const compiled = compile(text, { fileName: uri, readDocument: readFromDisk });
      const preview = new PreviewModel({ readDocument: readFromDisk });
      preview.setDocument(uri, text, 1);
      if (compiled.diagnostics.some((d) => d.category === 'error')) {
        expect(preview.module(uri)).toBeUndefined();
        return;
      }
      expect(packModule(preview.module(uri)!)).toEqual(packModule(compiled.module!));
      // The text tabs print the service's compiled output, which the compiler holds to
      // compile()'s own text (its compiled-output-parity test); here, that the panel shows it.
      // `inferred-returns` holds the same lines in another order there, and so it does here.
      const wgsl = preview.output(uri, 'wgsl')?.text;
      const lines = (text: string | undefined): string[] =>
        (text ?? '')
          .split('\n')
          .filter((line) => line.trim() !== '')
          .sort();
      if (file === 'inferred-returns.shade.ts') expect(lines(wgsl)).toEqual(lines(compiled.wgsl));
      else expect(wgsl).toBe(compiled.wgsl);
    });
  }
});

/** The file a shader imports, and where the model's host finds it. */
const LIBRARY_URI = 'file:///p/lib.shade.ts';
const LIBRARY = `"use typeshade"

export function double(x: f32): f32 {
  return x * 2.
}
`;

/** A shader that calls into {@link LIBRARY}. The two are one program (the compiler's Rule 3.9),
 *  whose module holds `double` and `fs`. */
const IMPORTER = `"use typeshade"

import { double } from './lib.shade.js'

@fragment
export function fs(): f32 {
  return double(2.)
}
`;

describe('a shader that imports another', () => {
  /** A model whose host reads imports from `files`, which a test may change under it, and which
   *  holds {@link IMPORTER}. */
  function importing(files: Map<string, string>): PreviewModel {
    const preview = new PreviewModel({ readDocument: shaderReader((uri) => files.get(uri)) });
    preview.setDocument(URI, IMPORTER, 1);
    return preview;
  }

  it('compiles with the file it imports, for every tab, the entry list and a run', () => {
    const preview = importing(new Map([[LIBRARY_URI, LIBRARY]]));
    const wgsl = preview.output(URI, 'wgsl');
    expect(wgsl?.diagnostics).toEqual([]);
    expect(wgsl?.text).toContain('fn double(x: f32) -> f32');

    const reflection = JSON.parse(preview.output(URI, 'reflection')?.text ?? '') as {
      entries: { name: string }[];
    };
    expect(reflection.entries.map((entry) => entry.name)).toEqual(['fs']);
    expect(preview.entries(URI).map((entry) => entry.name)).toEqual(['fs']);

    // What Run Entry hands the CPU oracle: the importer's module, the imported helper included.
    const module = preview.module(URI);
    expect(module?.funcs.map((fn) => fn.name)).toEqual(['double', 'fs']);
    expect(compileModule(module!, { precision: 'f32' }).fns.fs?.()).toBe(4);
  });

  it('reports a name the imported file stops exporting as TS8072, and recovers', () => {
    const preview = importing(new Map([[LIBRARY_URI, LIBRARY]]));
    expect(preview.entries(URI)).toHaveLength(1);

    // The library edited in the editor, which is how the extension hands the model a document.
    // The one mistake is the compiler's TS8072 on the import, and TypeScript's TS2305 for the
    // same name is merged into it (Rule 12.4).
    preview.setDocument(LIBRARY_URI, LIBRARY.replace('double', 'twice'), 1);
    const diagnostics = preview.output(URI, 'wgsl')?.diagnostics ?? [];
    expect(diagnostics.map((d) => d.code)).toEqual(['TS8072']);
    expect(diagnostics[0]?.message).toContain('has no export "double"');
    expect(preview.entries(URI)).toEqual([]);
    expect(preview.module(URI)).toBeUndefined();

    preview.setDocument(LIBRARY_URI, LIBRARY, 2);
    expect(preview.output(URI, 'wgsl')?.diagnostics).toEqual([]);
    expect(preview.entries(URI)).toHaveLength(1);
  });

  it('builds the module again when a file it imports changes where the model does not hold it', () => {
    // The entry list is cached per version of the document, and an import is as much a part of
    // the module: a change to the imported file on disk has to reach it with no edit to the
    // importer.
    const files = new Map([[LIBRARY_URI, LIBRARY]]);
    const preview = importing(files);
    expect(preview.entries(URI)).toHaveLength(1);
    files.set(LIBRARY_URI, LIBRARY.replace('double', 'twice'));
    expect(preview.entries(URI)).toEqual([]);
    files.set(LIBRARY_URI, LIBRARY);
    expect(preview.entries(URI)).toHaveLength(1);
  });

  it('reads an import only when it is a shader, as the plugin does', () => {
    const files = new Map([
      [LIBRARY_URI, LIBRARY],
      ['file:///p/util.ts', 'export const k = 1\n'],
    ]);
    const read = shaderReader((uri) => files.get(uri));
    expect(read(LIBRARY_URI)).toBe(LIBRARY);
    expect(read('file:///p/util.ts')).toBeUndefined();
    expect(read('file:///p/missing.shade.ts')).toBeUndefined();

    // A plain module is left unresolved, and the compiler says so on the import.
    const preview = importing(files);
    preview.setDocument(URI, IMPORTER.replace('./lib.shade.js', './util.js'), 2);
    expect(preview.output(URI, 'wgsl')?.diagnostics.map((d) => d.code)).toEqual(['TS8072']);
  });
});

describe("a shader that imports a package's by the package's name (the compiler's change 0024)", () => {
  const ROOT = 'file:///p/node_modules/shade-lib/';
  /** `shade-lib` installed beside the shader, publishing {@link LIBRARY} under the `typeshade`
   *  condition and JavaScript for hosts under `default`. */
  const PACKAGE = new Map([
    [
      `${ROOT}package.json`,
      JSON.stringify({
        name: 'shade-lib',
        version: '1.0.0',
        exports: { '.': { typeshade: './src/index.shade.ts', default: './dist/index.js' } },
      }),
    ],
    [`${ROOT}src/index.shade.ts`, LIBRARY],
    [`${ROOT}dist/index.js`, 'export const double = (x) => x * 2\n'],
  ]);

  it("compiles with the package's shader module, found through its package.json", () => {
    const read = shaderReader((uri) => PACKAGE.get(uri));
    // The package.json is served as it is, the shader module for its directive, and the
    // package's JavaScript not at all.
    expect(read(`${ROOT}package.json`)).toBe(PACKAGE.get(`${ROOT}package.json`));
    expect(read(`${ROOT}src/index.shade.ts`)).toBe(LIBRARY);
    expect(read(`${ROOT}dist/index.js`)).toBeUndefined();

    const preview = new PreviewModel({ readDocument: read });
    preview.setDocument(URI, IMPORTER.replace('./lib.shade.js', 'shade-lib'), 1);
    const wgsl = preview.output(URI, 'wgsl');
    expect(wgsl?.diagnostics).toEqual([]);
    expect(wgsl?.text).toContain('fn double(x: f32) -> f32');
    expect(preview.entries(URI).map((entry) => entry.name)).toEqual(['fs']);
    const module = preview.module(URI);
    expect(compileModule(module!, { precision: 'f32' }).fns.fs?.()).toBe(4);
  });

  it('reports a package no node_modules holds as TS8072, with where it looked', () => {
    const preview = new PreviewModel({ readDocument: shaderReader(() => undefined) });
    preview.setDocument(URI, IMPORTER.replace('./lib.shade.js', 'shade-lib'), 1);
    const diagnostics = preview.output(URI, 'wgsl')?.diagnostics ?? [];
    expect(diagnostics.map((d) => `${d.code} ${d.message}`)).toEqual([
      'TS8072 Cannot find the package "shade-lib" (looked in node_modules from "file:///p" up).',
    ]);
  });
});
