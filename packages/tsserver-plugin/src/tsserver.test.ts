import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BROKEN, CLEAN, CLEAN_WITHOUT_DIRECTIVE, INFERRED_PROJECT, PROJECT } from './fixtures.js'
import {
  Harness,
  removeFixture,
  startServer,
  writeFixture,
  type FileDiagnostics,
  type ProtocolDiagnostic,
} from './tsserver-harness.js'

/** The codes an unhelped editor reports on a valid shader, measured in
 *  `docs/measurements/two-program-cost/`: 58 of them across the compiler's six examples, every
 *  one false. A test that only counted diagnostics would pass on a plugin that broke
 *  TypeScript entirely, so the classes are named. */
const FALSE_POSITIVE_CODES = [1206, 2304, 2349, 2552]

/** Every diagnostic of the three kinds, which is what most assertions read. */
function all(diagnostics: FileDiagnostics): readonly ProtocolDiagnostic[] {
  return [...diagnostics.semantic, ...diagnostics.syntactic, ...diagnostics.suggestion]
}

/** A diagnostic as `code@line`, with its source, which is the form that makes a contrast
 *  between two servers readable in a failure message. */
function summarize(diagnostics: readonly ProtocolDiagnostic[]): string[] {
  return diagnostics.map((d) => `${d.code ?? 0}${d.source ? `/${d.source}` : ''}@${d.start.line}`)
}

/** Runs `body` against a server with no plugin at all, on its own copy of the fixture. Every
 *  assertion that claims the plugin changed something uses this, because an assertion that
 *  passes without the plugin proves nothing. */
async function withBareServer<T>(
  files: Readonly<Record<string, string>>,
  body: (server: Harness) => Promise<T>,
): Promise<T> {
  const dir = writeFixture(files)
  const server = startServer({ dir, plugin: false })
  try {
    return await body(server)
  } finally {
    server.stop()
    removeFixture(dir)
  }
}

describe('the plugin, in a real tsserver', () => {
  let dir: string
  let server: Harness

  beforeAll(() => {
    dir = writeFixture(PROJECT)
    server = startServer({ dir })
  })

  afterAll(() => {
    server.stop()
    removeFixture(dir)
  })

  it('reports nothing on a clean shader, where an unhelped editor reports the false ones', async () => {
    server.open('clean.shade.ts')
    expect(all(await server.diagnostics('clean.shade.ts'))).toEqual([])

    const bare = await withBareServer(PROJECT, async (s) => {
      s.open('clean.shade.ts')
      return (await s.diagnostics('clean.shade.ts')).semantic
    })
    expect(bare.length).toBeGreaterThan(0)
    expect(bare.map((d) => d.code).some((code) => FALSE_POSITIVE_CODES.includes(code ?? 0))).toBe(
      true,
    )
  })

  it('reports the real errors and only those, from the TypeShade program', async () => {
    // Not just "8004 is present": a regression that concatenated the project program's answer
    // would pass that. The contrast is exact. The bare server reports TS1206 on the decorator
    // and TS2304 twice, once for `f32` and once for `nope`; the plugin reports the `nope` one,
    // which is real, with no source because it came from the TypeShade program's own TypeScript
    // pass, plus TS8004 from the front end.
    server.open('broken.shade.ts')
    const withPlugin = (await server.diagnostics('broken.shade.ts')).semantic
    const bare = await withBareServer(PROJECT, async (s) => {
      s.open('broken.shade.ts')
      return (await s.diagnostics('broken.shade.ts')).semantic
    })

    expect(summarize(bare).sort()).toEqual(['1206@3', '2304@4', '2304@5'])
    expect(summarize(withPlugin).sort()).toEqual(['2304@5', '8004/typeshade@5'])
    expect(withPlugin.find((d) => d.code === 2304)?.source).toBeUndefined()
    expect(withPlugin.find((d) => d.code === 8004)?.text).toContain('Unknown function')
  })

  it('underlines a broken paren once, not twice', async () => {
    // The service's own answer includes the TypeShade program's syntactic diagnostics, and the
    // decoration passes tsserver's syntactic pass through, so without the deduplication the
    // same TS1005 would arrive from both.
    server.open('syntax.shade.ts')
    const occurrences = all(await server.diagnostics('syntax.shade.ts')).filter(
      (d) => d.code === 1005,
    )
    expect(occurrences).toHaveLength(1)
  })

  it('answers quick info from the compiler, where an unhelped editor says any', async () => {
    // At `vec4`, not at `tint`: `tint` is an ordinary function declaration that the bare server
    // also describes correctly, so an assertion there passes with the plugin deleted.
    server.open('clean.shade.ts')
    const at = { file: server.file('clean.shade.ts'), ...Harness.at(12, 19) }
    const withPlugin = await server.request<{ displayString?: string }>('quickinfo', at)
    const bare = await withBareServer(PROJECT, async (s) => {
      s.open('clean.shade.ts')
      return s.request<{ displayString?: string }>('quickinfo', {
        ...at,
        file: s.file('clean.shade.ts'),
      })
    })

    expect(bare?.displayString).toBe('any')
    expect(withPlugin?.displayString ?? '').toContain('vec4')
  })

  it('splits a hover into a signature and its prose', async () => {
    // `ts.QuickInfo` renders display parts inside a TypeScript code fence, so the Markdown the
    // service returns has to be split rather than pasted into one field.
    server.open('clean.shade.ts')
    const body = await server.request<{ displayString?: string; documentation?: string }>(
      'quickinfo',
      { file: server.file('clean.shade.ts'), ...Harness.at(6, 17) },
    )
    expect(body?.displayString).toBe('function tint(x: f32): f32')
    expect(body?.displayString ?? '').not.toContain('```')
  })

  it('offers the attribute vocabulary, and the builtin ids inside @builtin("', async () => {
    server.open('clean.shade.ts')
    const attributes = await server.completions('clean.shade.ts', Harness.at(10, 0))
    expect(attributes).toContain('@fragment')

    // Inside the string of a `@builtin(...)`, the service offers the WGSL builtin vocabulary,
    // which is the completion no TypeScript program could produce: all fifteen ids, because a
    // struct field has no enclosing stage to filter them by. A bare server offers the string's
    // own text and nothing else.
    server.open('builtin.shade.ts')
    const builtins = await server.completions('builtin.shade.ts', Harness.at(3, 12))
    expect(builtins).toContain('vertex_index')
    expect(builtins).toContain('position')
    expect(builtins).toHaveLength(15)

    const bare = await withBareServer(PROJECT, async (s) => {
      s.open('builtin.shade.ts')
      return s.completions('builtin.shade.ts', Harness.at(3, 12))
    })
    expect(bare).not.toContain('vertex_index')
  })

  it('answers references from the TypeShade program, across files', async () => {
    // tsserver calls `findReferences`, never `getReferencesAtPosition`, so a decoration that
    // overrode only the latter would leave this answered by the project's program. A
    // single-file count proves nothing (the bare server finds the same two), so this asserts
    // the entry shape the conversion fills in and that the plugin is actually loaded.
    server.open('clean.shade.ts')
    const body = await server.request<{
      refs?: { file: string; isDefinition?: boolean; contextStart?: unknown }[]
    }>('references', { file: server.file('clean.shade.ts'), ...Harness.at(6, 17) })

    expect(body?.refs ?? []).toHaveLength(2)
    expect((body?.refs ?? []).filter((ref) => ref.isDefinition)).toHaveLength(1)
    expect(server.log()).toContain('[typeshade] plugin loaded')

    const bare = await withBareServer(PROJECT, async (s) => {
      s.open('clean.shade.ts')
      return s.request<{ refs?: { isDefinition?: boolean }[] }>('references', {
        file: s.file('clean.shade.ts'),
        ...Harness.at(6, 17),
      })
    })
    // The bare server finds the same two, which is why the count alone is not the assertion.
    expect(bare?.refs ?? []).toHaveLength(2)
  })

  it('answers the region diagnostics a long shader triggers', async () => {
    // tsserver reaches `getRegionSemanticDiagnostics` only when the `geterr` item carries
    // `ranges` (`typescript.js:190942`); a plain file name never does, whatever the line count.
    // The method is undeclared in `typescript.d.ts`, so a decoration over the declared members
    // alone would republish TypeScript's own errors here and nowhere else.
    server.open('big.shade.ts')
    const ranges = [{ startLine: 1, startOffset: 1, endLine: 12, endOffset: 1 }]
    const withPlugin = await server.regionDiagnostics('big.shade.ts', ranges)
    expect(withPlugin.kind).toBe('regionSemanticDiag')
    expect(withPlugin.diagnostics).toEqual([])

    const bare = await withBareServer(PROJECT, async (s) => {
      s.open('big.shade.ts')
      return s.regionDiagnostics('big.shade.ts', ranges)
    })
    expect(bare.kind).toBe('regionSemanticDiag')
    expect(bare.diagnostics.length).toBeGreaterThan(0)
  })

  it('writes no TypeScript into a shader through the code-action family', async () => {
    // Every one of these takes an options object rather than a file name first, which is how an
    // earlier guard let them through: Fix All then answered with the project program's
    // `function nope(arg0: number): f32 { throw new Error(...) }`, written into a shader.
    server.open('broken.shade.ts')
    const file = server.file('broken.shade.ts')

    const combined = await server.request<{ changes?: unknown[] }>('getCombinedCodeFix', {
      scope: { type: 'file', args: { file } },
      fixId: 'fixMissingFunctionDeclaration',
    })
    expect(combined?.changes ?? []).toEqual([])

    const organized = await server.request<unknown[]>('organizeImports', {
      scope: { type: 'file', args: { file } },
    })
    expect(organized ?? []).toEqual([])

    const pasted = await server.request<{ edits?: unknown[] }>('getPasteEdits', {
      file,
      pastedText: ['const x = 1'],
      pasteLocations: [{ start: { line: 5, offset: 1 }, end: { line: 5, offset: 1 } }],
    })
    expect(pasted?.edits ?? []).toEqual([])

    const mapped = await server.request<unknown[]>('mapCode', {
      file,
      mapping: { contents: ['const x = 1'], focusLocations: [] },
    })
    expect(mapped ?? []).toEqual([])

    // What the bare server does with the same request, so the assertions above are a contrast
    // rather than a description of an empty feature.
    const bare = await withBareServer(PROJECT, async (s) => {
      s.open('broken.shade.ts')
      return s.request<{ changes?: { textChanges?: { newText?: string }[] }[] }>(
        'getCombinedCodeFix',
        {
          scope: { type: 'file', args: { file: s.file('broken.shade.ts') } },
          fixId: 'fixMissingFunctionDeclaration',
        },
      )
    })
    const written = (bare?.changes ?? []).flatMap((change) =>
      (change.textChanges ?? []).map((edit) => edit.newText ?? ''),
    )
    expect(written.join('')).toContain('function nope')
  })

  it('resolves an import between two shaders, and sees an edit to the imported one', async () => {
    server.open('main.shade.ts')
    server.open('lib.shade.ts')
    const before = await server.diagnostics('main.shade.ts')
    // The module resolves: no TS2307. What remains is the compiler's own multi-file gap, since
    // the front end does not yet collect declarations across files
    // (`docs/language-service-api.md` §11), so the cross-file call reads as unknown.
    expect(all(before).map((d) => d.code)).not.toContain(2307)
    expect(before.semantic.some((d) => d.source === 'typeshade' && d.code === 8004)).toBe(true)

    // Renaming the export must reach the importer's answer without anything asking about the
    // imported file: the service caches a file it pulled in through `readDocument` and never
    // re-reads it, so the sync has to re-send every document whose version moved.
    server.reopen('lib.shade.ts', PROJECT['lib.shade.ts'].replace('double', 'twice'))
    const after = await server.diagnostics('main.shade.ts')
    // TS2305, not TS2724: `twice` is too far from `double` for the spelling suggestion the
    // latter carries, and the message is the one that names what the importer can no longer
    // find.
    expect(after.semantic.map((d) => d.code)).toContain(2305)
    expect(after.semantic.find((d) => d.code === 2305)?.text).toContain('double')

    server.reopen('lib.shade.ts', PROJECT['lib.shade.ts'])
    expect((await server.diagnostics('main.shade.ts')).semantic.map((d) => d.code)).not.toContain(
      2305,
    )
  })

  it('gives TypeScript its file back when the directive is deleted', async () => {
    server.open('clean.shade.ts')
    expect(all(await server.diagnostics('clean.shade.ts'))).toEqual([])
    server.reopen('clean.shade.ts', CLEAN_WITHOUT_DIRECTIVE)
    const after = await server.diagnostics('clean.shade.ts')
    expect(after.semantic.length).toBeGreaterThan(0)
    expect(after.semantic.every((d) => d.source !== 'typeshade')).toBe(true)
    server.reopen('clean.shade.ts', CLEAN)
    expect(all(await server.diagnostics('clean.shade.ts'))).toEqual([])
  })

  it('never logs a decoration failure', () => {
    // A plugin that throws is caught and passed through, which keeps the editor working and
    // makes the failure silent. The log is the only place it shows.
    expect(server.log()).not.toContain('decoration failed')
    expect(server.log()).toContain('[typeshade] plugin loaded')
  })
})

describe('a workspace with no tsconfig.json', () => {
  it('still gets the plugin, through the inferred project', async () => {
    const dir = writeFixture(INFERRED_PROJECT)
    const server = startServer({ dir })
    try {
      server.open('clean.shade.ts')
      expect(all(await server.diagnostics('clean.shade.ts'))).toEqual([])
    } finally {
      server.stop()
      removeFixture(dir)
    }
  })
})

describe('a file without the directive', () => {
  it('produces the same events as a server with no plugin at all', async () => {
    // The only test that can prove a pass-through has no mapping layer in it: the same scripted
    // session against two servers, one with the plugin and one without, compared as the event
    // stream an editor would act on.
    const withDir = writeFixture(PROJECT)
    const withoutDir = writeFixture(PROJECT)
    const withPlugin = startServer({ dir: withDir })
    const withoutPlugin = startServer({ dir: withoutDir, plugin: false })
    try {
      const script = async (server: Harness): Promise<string> => {
        server.open('host.ts')
        server.open('host-imports-shader.ts')
        const results: unknown[] = []
        results.push(await server.diagnostics('host.ts'))
        results.push(await server.diagnostics('host-imports-shader.ts'))
        const at = { file: server.file('host.ts'), ...Harness.at(5, 17) }
        results.push(await server.request('quickinfo', at))
        results.push(
          await server.request('completionInfo', {
            file: server.file('host.ts'),
            ...Harness.at(6, 21),
          }),
        )
        results.push(await server.request('navtree', { file: server.file('host.ts') }))
        results.push(await server.request('references', at))
        results.push(
          await server.request('documentHighlights', {
            ...at,
            filesToSearch: [server.file('host.ts')],
          }),
        )
        results.push(
          await server.request('organizeImports', {
            scope: { type: 'file', args: { file: server.file('host.ts') } },
          }),
        )
        const answers = JSON.stringify(results).split(server.file('')).join('<dir>/')
        return `${answers}\n${server.comparableEvents()}`
      }
      expect(await script(withPlugin)).toEqual(await script(withoutPlugin))
    } finally {
      withPlugin.stop()
      withoutPlugin.stop()
      removeFixture(withDir)
      removeFixture(withoutDir)
    }
  })
})

describe('the fixture with a real error', () => {
  it('is the shape the assertions above assume', () => {
    // A guard on the fixture rather than on the plugin: if `BROKEN` ever stops calling a
    // function that does not exist, the contrast test above would still pass while proving
    // nothing.
    expect(BROKEN).toContain('nope(1.)')
  })
})
