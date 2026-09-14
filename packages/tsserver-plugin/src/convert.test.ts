import { describe, expect, it } from 'vitest'
import typescript from 'typescript'
import { createTypeshadeLanguageService } from './compiler.js'
import {
  splitHover,
  toClassifications,
  toTsDiagnostic,
  withoutSyntacticDuplicates,
} from './convert.js'
import type { ConvertContext } from './convert.js'
import { CLEAN } from './fixtures.js'

const URI = '/p/a.shade.ts'

function context(): ConvertContext {
  const shade = createTypeshadeLanguageService()
  shade.openDocument(URI, CLEAN, 1)
  return { typescript, shade }
}

describe('the hover split', () => {
  it('puts the fenced block in the signature and the rest in the prose', () => {
    // `ts.QuickInfo` renders its display parts inside a TypeScript code fence, so Markdown put
    // there renders as code. The first fenced block is the signature; everything else is prose.
    const { signature, prose } = splitHover(
      '```ts\nfunction tint(x: f32): f32\n```\n\nRounds down.',
    )
    expect(signature).toBe('function tint(x: f32): f32')
    expect(prose).toBe('Rounds down.')
  })

  it('puts a hover with no fenced block entirely in the prose', () => {
    expect(splitHover('Just words.')).toEqual({ signature: '', prose: 'Just words.' })
  })
})

describe('diagnostics', () => {
  it('carries the numeric code and the typeshade source', () => {
    const ctx = context()
    const sourceFile = typescript.createSourceFile(URI, CLEAN, typescript.ScriptTarget.ES2022)
    const converted = toTsDiagnostic(ctx, sourceFile, {
      uri: URI,
      span: { start: 3, length: 4 },
      range: { start: { line: 0, character: 3 }, end: { line: 0, character: 7 } },
      severity: 'error',
      message: 'nope',
      code: 'TS8004',
      source: 'typeshade',
    })
    expect(converted.code).toBe(8004)
    expect(converted.source).toBe('typeshade')
    expect(converted.category).toBe(typescript.DiagnosticCategory.Error)
  })

  it('leaves a TypeScript-sourced diagnostic looking like TypeScript', () => {
    const ctx = context()
    const sourceFile = typescript.createSourceFile(URI, CLEAN, typescript.ScriptTarget.ES2022)
    const converted = toTsDiagnostic(ctx, sourceFile, {
      uri: URI,
      span: { start: 0, length: 1 },
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 'error',
      message: 'nope',
      code: 1005,
      source: 'typescript',
    })
    expect(converted.code).toBe(1005)
    expect(converted.source).toBeUndefined()
  })

  it('drops what the syntactic pass already reported', () => {
    const shared = { code: 1005, start: 10, length: 1 }
    const semantic = [shared, { code: 2322, start: 20, length: 3 }] as never[]
    const syntactic = [shared] as never[]
    expect(withoutSyntacticDuplicates(semantic, syntactic)).toHaveLength(1)
  })
})

describe('semantic classifications', () => {
  it('encodes what maps and drops what does not', () => {
    // Seven of TypeShade's thirteen token types have no counterpart in the 2020 legend, and the
    // legend belongs to VS Code's built-in TypeScript extension, so a dropped token is the
    // honest answer: TextMate still colours it.
    const ctx = context()
    const encoded = toClassifications(ctx, URI, [
      { line: 6, character: 16, length: 4, type: 'function', modifiers: ['declaration'] },
      { line: 6, character: 21, length: 1, type: 'builtin', modifiers: [] },
    ])
    expect(encoded.spans).toHaveLength(3)
    // (function + 1) << 8 | (1 << declaration)
    expect(encoded.spans[2]).toBe(((10 + 1) << 8) | 1)
  })
})
