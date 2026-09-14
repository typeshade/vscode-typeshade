import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CLEAN, CLEAN_WITHOUT_DIRECTIVE, INFERRED_PROJECT, PROJECT } from './fixtures.js'
import {
  Harness,
  removeFixture,
  startServer,
  writeFixture,
  type FileDiagnostics,
} from './tsserver-harness.js'

/** The codes an unhelped editor reports on a valid shader, measured in
 *  `docs/measurements/two-program-cost/`: 58 of them across the compiler's six examples, every
 *  one false. A test that only counted diagnostics would pass on a plugin that broke
 *  TypeScript entirely, so the classes are named. */
const FALSE_POSITIVE_CODES = [1206, 2304, 2349, 2552]

/** Every diagnostic of the three kinds, which is what most assertions read. */
function all(diagnostics: FileDiagnostics): readonly { code?: number; source?: string }[] {
  return [...diagnostics.semantic, ...diagnostics.syntactic, ...diagnostics.suggestion]
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
    const withPlugin = await server.diagnostics('clean.shade.ts')
    expect(all(withPlugin)).toEqual([])

    const bareDir = writeFixture(PROJECT)
    const bare = startServer({ dir: bareDir, plugin: false })
    try {
      bare.open('clean.shade.ts')
      const withoutPlugin = await bare.diagnostics('clean.shade.ts')
      const codes = withoutPlugin.semantic.map((d) => d.code)
      expect(codes.length).toBeGreaterThan(0)
      expect(codes.some((code) => FALSE_POSITIVE_CODES.includes(code ?? 0))).toBe(true)
    } finally {
      bare.stop()
      removeFixture(bareDir)
    }
  })

  it('reports a real TypeShade error under its own code and source', async () => {
    server.open('broken.shade.ts')
    const diagnostics = await server.diagnostics('broken.shade.ts')
    const typeshade = diagnostics.semantic.filter((d) => d.source === 'typeshade')
    expect(typeshade.map((d) => d.code)).toContain(8004)
    // The numeric part of `TS8004`, with the source field telling it apart from TypeScript's own
    // 8001 to 8039 family (`docs/design.md` §3).
    expect(typeshade[0].text).toContain('Unknown function')
  })

  it('underlines a broken paren once, not twice', async () => {
    // The service's own answer includes the TypeShade program's syntactic diagnostics, and the
    // decoration passes tsserver's syntactic pass through, so without the deduplication the
    // same TS1005 would arrive from both.
    server.open('syntax.shade.ts')
    const diagnostics = await server.diagnostics('syntax.shade.ts')
    const occurrences = all(diagnostics).filter((d) => d.code === 1005)
    expect(occurrences).toHaveLength(1)
  })

  it('answers quick info from the compiler, not as any', async () => {
    server.open('clean.shade.ts')
    const body = await server.request<{ displayString?: string; documentation?: string }>(
      'quickinfo',
      { file: server.file('clean.shade.ts'), ...Harness.at(6, 17) },
    )
    expect(body?.displayString ?? '').toContain('tint')
    expect(body?.displayString).not.toBe('any')
  })

  it('offers the attribute vocabulary where an attribute can start', async () => {
    server.open('clean.shade.ts')
    const body = await server.request<{ entries?: { name: string }[] } | { name: string }[]>(
      'completionInfo',
      { file: server.file('clean.shade.ts'), ...Harness.at(10, 0) },
    )
    const entries = Array.isArray(body) ? body : (body?.entries ?? [])
    expect(entries.map((entry) => entry.name)).toContain('@fragment')
  })

  it('answers references from the TypeShade program', async () => {
    // tsserver calls `findReferences`, never `getReferencesAtPosition`, so a decoration that
    // overrode only the latter would leave this answered by the project's program with nothing
    // failing (`docs/design.md` §3).
    server.open('clean.shade.ts')
    const body = await server.request<{ refs?: { file: string }[] }>('references', {
      file: server.file('clean.shade.ts'),
      ...Harness.at(6, 17),
    })
    expect(body?.refs ?? []).toHaveLength(2)
  })

  it('reports nothing on a shader past the region diagnostics threshold', async () => {
    // Over 500 lines tsserver asks `getRegionSemanticDiagnostics`, which is not declared in
    // `typescript.d.ts`; a decoration that only overrode declared members would republish
    // TypeScript's own errors here and nowhere else. Asked twice, because the region path is
    // taken on the second request for a file the server has already seen.
    server.open('big.shade.ts')
    expect(all(await server.diagnostics('big.shade.ts'))).toEqual([])
    expect(all(await server.diagnostics('big.shade.ts'))).toEqual([])
  })

  it('resolves an import between two shaders', async () => {
    server.open('main.shade.ts')
    const diagnostics = await server.diagnostics('main.shade.ts')
    // The module resolves: no TS2307. What remains is the compiler's own multi-file gap, since
    // the front end does not yet collect declarations across files
    // (`docs/language-service-api.md` §11), so the cross-file call reads as unknown. That is a
    // fact about the compiler, and this asserts it rather than hiding it.
    expect(all(diagnostics).map((d) => d.code)).not.toContain(2307)
    expect(diagnostics.semantic.some((d) => d.source === 'typeshade' && d.code === 8004)).toBe(true)
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
  it('gets answers identical to a server with no plugin at all', async () => {
    // The only test that can prove a pass-through has no mapping layer in it: the same scripted
    // session against two servers, one with the plugin and one without, compared whole.
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
        results.push(
          await server.request('quickinfo', { file: server.file('host.ts'), ...Harness.at(5, 17) }),
        )
        results.push(
          await server.request('completionInfo', {
            file: server.file('host.ts'),
            ...Harness.at(6, 21),
          }),
        )
        results.push(await server.request('navtree', { file: server.file('host.ts') }))
        results.push(
          await server.request('references', {
            file: server.file('host.ts'),
            ...Harness.at(5, 17),
          }),
        )
        results.push(
          await server.request('documentHighlights', {
            file: server.file('host.ts'),
            ...Harness.at(5, 17),
            filesToSearch: [server.file('host.ts')],
          }),
        )
        return JSON.stringify(results).split(server.file('')).join('<dir>/')
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
