import { describe, expect, it } from 'vitest'
import typescript from 'typescript'
import { createTypeshadeLanguageService } from './compiler.js'
import { DocumentSync } from './documents.js'
import { CLEAN, CLEAN_WITHOUT_DIRECTIVE, LIB } from './fixtures.js'
import { testProject } from './testing.js'

/** A sync over a project, with the service it feeds. */
function setup(files: Readonly<Record<string, string>>) {
  const project = testProject(files)
  let sync: DocumentSync | undefined
  const shade = createTypeshadeLanguageService({ readDocument: (uri) => sync?.readDocument(uri) })
  sync = new DocumentSync(typescript, project.host, shade)
  return { project, shade, sync }
}

describe('document sync', () => {
  it('opens a shader and keeps it current', () => {
    const { project, shade, sync } = setup({ '/p/a.shade.ts': CLEAN })
    expect(sync.sync('/p/a.shade.ts', true)).toBe(true)
    expect(shade.getDiagnostics('/p/a.shade.ts')).toEqual([])

    project.edit('/p/a.shade.ts', CLEAN.replace('x * 0.5', 'x * nope'))
    sync.sync('/p/a.shade.ts', true)
    expect(shade.getDiagnostics('/p/a.shade.ts').length).toBeGreaterThan(0)
  })

  it('closes a file that loses its directive, which nothing else can', () => {
    // The file is still a member of the project, so no prune reaches it: without this the
    // TypeShade program would hold a plain TypeScript file forever.
    const { shade, sync } = setup({ '/p/a.shade.ts': CLEAN })
    sync.sync('/p/a.shade.ts', true)
    expect(sync.openFileNames()).toEqual(['/p/a.shade.ts'])

    expect(sync.sync('/p/a.shade.ts', false)).toBe(false)
    expect(sync.openFileNames()).toEqual([])
    expect(shade.getDiagnostics('/p/a.shade.ts')).toEqual([])
  })

  it('drops a file the project no longer holds, on the next project version', () => {
    const { project, sync } = setup({ '/p/a.shade.ts': CLEAN, '/p/b.shade.ts': LIB })
    sync.sync('/p/a.shade.ts', true)
    sync.sync('/p/b.shade.ts', true)
    expect(sync.openFileNames()).toHaveLength(2)

    project.remove('/p/b.shade.ts')
    sync.sync('/p/a.shade.ts', true)
    expect(sync.openFileNames()).toEqual(['/p/a.shade.ts'])
  })

  it('serves an imported shader, and refuses one that is not a shader', () => {
    const { sync } = setup({
      '/p/lib.shade.ts': LIB,
      '/p/plain.ts': CLEAN_WITHOUT_DIRECTIVE,
    })
    expect(sync.readDocument('/p/lib.shade.ts')).toContain('use typeshade')
    // A plain TypeScript module is written for the standard library and the TypeShade program
    // has none, so pulling it in would report errors inside a file nobody asked to be a shader.
    expect(sync.readDocument('/p/plain.ts')).toBeUndefined()
    expect(sync.readDocument('/p/missing.shade.ts')).toBeUndefined()
  })

  it('promotes a served import to a real document, so an edit to it is seen', () => {
    // The service's host caches a file pulled in through `readDocument` and never re-reads it,
    // so an edit to an imported shader would otherwise be invisible to the importer.
    const { project, sync } = setup({ '/p/main.shade.ts': CLEAN, '/p/lib.shade.ts': LIB })
    sync.readDocument('/p/lib.shade.ts')
    sync.sync('/p/main.shade.ts', true)
    expect(sync.openFileNames()).toContain('/p/lib.shade.ts')

    project.edit('/p/lib.shade.ts', LIB.replace('x * 2.', 'x * 3.'))
    sync.sync('/p/main.shade.ts', true)
    expect(sync.openFileNames()).toContain('/p/lib.shade.ts')
  })
})
