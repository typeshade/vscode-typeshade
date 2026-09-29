import { describe, expect, it } from 'vitest';
import { createTypeshadeLanguageService } from './compiler.js';
import { BROKEN, CLEAN } from './fixtures.js';
import { programName, withProgramNames } from './program-names.js';

const UNTITLED = '^/untitled/ts-nul-authority/Untitled-1';

describe('the name the TypeShade program holds a file under', () => {
  it('keeps a TypeScript name and aliases one with no extension', () => {
    expect(programName('/p/main.shade.ts')).toBe('/p/main.shade.ts');
    expect(programName('/p/view.mts')).toBe('/p/view.mts');
    expect(programName(UNTITLED)).toBe(`${UNTITLED}.ts`);
  });

  it('is needed: the service alone answers nothing for an untitled name', () => {
    const bare = createTypeshadeLanguageService({});
    bare.openDocument(UNTITLED, BROKEN, 1);
    expect(bare.getDiagnostics(UNTITLED)).toEqual([]);
  });

  it('reports under the name it was asked about, and never the alias', () => {
    const shade = withProgramNames(createTypeshadeLanguageService({}));
    shade.openDocument(UNTITLED, BROKEN, 1);
    const diagnostics = shade.getDiagnostics(UNTITLED);
    expect(diagnostics.map((d) => [d.code, d.uri])).toEqual([['TS8004', UNTITLED]]);
  });

  it('turns the alias back in definitions, references and a rename', () => {
    const shade = withProgramNames(createTypeshadeLanguageService({}));
    shade.openDocument(UNTITLED, CLEAN, 1);
    // `tint` at its call inside `fs`.
    const call = shade.positionAt(UNTITLED, CLEAN.lastIndexOf('tint('));
    expect(shade.getDefinition(UNTITLED, call).map((l) => l.uri)).toEqual([UNTITLED]);
    const references = shade.getReferences(UNTITLED, call, { includeDeclaration: true });
    expect(references.length).toBe(2);
    expect(new Set(references.map((l) => l.uri))).toEqual(new Set([UNTITLED]));
    expect(Object.keys(shade.rename(UNTITLED, call, 'shade'))).toEqual([UNTITLED]);
  });

  it('forgets the alias with the document', () => {
    const shade = withProgramNames(createTypeshadeLanguageService({}));
    shade.openDocument(UNTITLED, BROKEN, 1);
    shade.closeDocument(UNTITLED);
    shade.openDocument(UNTITLED, CLEAN, 2);
    expect(shade.getDiagnostics(UNTITLED)).toEqual([]);
  });
});
