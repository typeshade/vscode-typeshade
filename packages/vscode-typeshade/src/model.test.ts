import { describe, expect, it } from 'vitest';
import { compileModule } from './compiler.js';
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
