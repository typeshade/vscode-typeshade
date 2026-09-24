import { describe, expect, it } from 'vitest';
import typescript from 'typescript';
import { createTypeshadeLanguageService } from './compiler.js';
import {
  splitHover,
  toClassifications,
  toTsDiagnostic,
  withoutSyntacticDuplicates,
} from './convert.js';
import type { ConvertContext } from './convert.js';
import type { TypeshadeDiagnostic } from './compiler.js';
import type ts from 'typescript';
import { CLEAN } from './fixtures.js';

const URI = '/p/a.shade.ts';

/** One diagnostic, filled out enough for the filter to read. The range is not used there and is
 *  derived from the span so the object is still a whole `TypeshadeDiagnostic`. */
function diagnostic(
  code: string | number,
  start: number,
  length: number,
  source: TypeshadeDiagnostic['source'],
): TypeshadeDiagnostic {
  return {
    uri: URI,
    span: { start, length },
    range: { start: { line: 0, character: start }, end: { line: 0, character: start + length } },
    severity: 'error',
    message: 'nope',
    code,
    source,
  };
}

function context(): ConvertContext {
  const shade = createTypeshadeLanguageService();
  shade.openDocument(URI, CLEAN, 1);
  return { typescript, shade };
}

describe('the hover split', () => {
  it('puts the fenced block in the signature and the rest in the prose', () => {
    // `ts.QuickInfo` renders its display parts inside a TypeScript code fence, so Markdown put
    // there renders as code. The first fenced block is the signature; everything else is prose.
    const { signature, prose } = splitHover(
      '```ts\nfunction tint(x: f32): f32\n```\n\nRounds down.',
    );
    expect(signature).toBe('function tint(x: f32): f32');
    expect(prose).toBe('Rounds down.');
  });

  it('puts a hover with no fenced block entirely in the prose', () => {
    expect(splitHover('Just words.')).toEqual({ signature: '', prose: 'Just words.' });
  });
});

describe('diagnostics', () => {
  it('carries the numeric code and the typeshade source', () => {
    const ctx = context();
    const sourceFile = typescript.createSourceFile(URI, CLEAN, typescript.ScriptTarget.ES2022);
    const converted = toTsDiagnostic(ctx, sourceFile, {
      uri: URI,
      span: { start: 3, length: 4 },
      range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } },
      severity: 'error',
      message: 'nope',
      code: 'TS8004',
      source: 'typeshade',
    });
    expect(converted.code).toBe(8004);
    expect(converted.source).toBe('typeshade');
    expect(converted.category).toBe(typescript.DiagnosticCategory.Error);
  });

  it('leaves a TypeScript-sourced diagnostic looking like TypeScript', () => {
    const ctx = context();
    const sourceFile = typescript.createSourceFile(URI, CLEAN, typescript.ScriptTarget.ES2022);
    const converted = toTsDiagnostic(ctx, sourceFile, {
      uri: URI,
      span: { start: 0, length: 1 },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 'error',
      message: 'nope',
      code: 1005,
      source: 'typescript',
    });
    expect(converted.code).toBe(1005);
    expect(converted.source).toBeUndefined();
  });

  it('drops what the syntactic pass already reported, and only from TypeScript', () => {
    // The filter runs before conversion, where `source` is still readable, and that is the
    // whole point: a TypeShade code that shares a number and a span with a TypeScript one is
    // not a duplicate of it. `shared` and `collides` sit at the same span with the same number
    // and only the first is dropped.
    const shared = diagnostic(1005, 10, 1, 'typescript');
    const collides = diagnostic('TS1005', 10, 1, 'typeshade');
    const other = diagnostic(2322, 20, 3, 'typescript');
    const syntactic = [{ code: 1005, start: 10, length: 1 }] as ts.DiagnosticWithLocation[];

    const kept = withoutSyntacticDuplicates([shared, collides, other], syntactic);
    expect(kept).toEqual([collides, other]);
  });

  it('keeps everything when the syntactic pass reported nothing', () => {
    const only = diagnostic(1005, 10, 1, 'typescript');
    expect(withoutSyntacticDuplicates([only], [])).toEqual([only]);
  });
});

describe('semantic classifications', () => {
  it('encodes what maps and drops what does not', () => {
    // Seven of TypeShade's thirteen token types have no counterpart in the 2020 legend, and the
    // legend belongs to VS Code's built-in TypeScript extension, so a dropped token is the
    // honest answer: TextMate still colours it.
    const ctx = context();
    const encoded = toClassifications(ctx, URI, [
      { line: 6, character: 16, length: 4, type: 'function', modifiers: ['declaration'] },
      { line: 6, character: 21, length: 1, type: 'builtin', modifiers: [] },
    ]);
    expect(encoded.spans).toHaveLength(3);
    // (function + 1) << 8 | (1 << declaration)
    expect(encoded.spans[2]).toBe(((10 + 1) << 8) | 1);
  });
});
