import { describe, expect, it } from 'vitest'
import { PreviewModel } from './model.js'

const URI = 'file:///p/hello.shade.ts'

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
`

/** The same shader mid-edit: the call is unfinished, which is a parse error. */
const BROKEN = SHADER.replace('vec4(input.uv.x, 0., 0., 1.)', 'vec4(input.uv.x, 0., 0.,')

function model(text = SHADER): PreviewModel {
  const created = new PreviewModel()
  created.setDocument(URI, text, 1)
  return created
}

describe('the preview model', () => {
  it('compiles the three text tabs', () => {
    const preview = model()
    expect(preview.output(URI, 'wgsl')?.text).toContain('@vertex')
    expect(preview.output(URI, 'glsl-vertex')?.text).toContain('void main')
    expect(preview.output(URI, 'glsl-fragment')?.text).toContain('void main')
  })

  it('answers reflection as the JSON a reader can scroll', () => {
    const text = model().output(URI, 'reflection')?.text ?? ''
    // Parsed rather than matched, because the tab's whole value is that the structure is
    // readable: a string match would pass on a one-line dump.
    const reflection = JSON.parse(text) as { entries: { name: string; stage: string }[] }
    expect(reflection.entries.map((entry) => `${entry.stage} ${entry.name}`)).toEqual([
      'vertex vs',
      'fragment fs',
    ])
    expect(text.split('\n').length).toBeGreaterThan(10)
  })

  it('shows the last output that compiled while the file is broken', () => {
    // This is §4's rule, and the reason it exists: a blank panel while you are mid-edit is worse
    // than a stale one that says it is stale.
    const preview = model()
    const good = preview.output(URI, 'wgsl')?.text ?? ''
    expect(good).toContain('@vertex')

    preview.setDocument(URI, BROKEN, 2)
    const during = preview.output(URI, 'wgsl')
    expect(during?.stale).toBe(true)
    expect(during?.text).toBe(good)
    expect(during?.diagnostics.some((d) => d.severity === 'error')).toBe(true)

    preview.setDocument(URI, SHADER, 3)
    expect(preview.output(URI, 'wgsl')?.stale).toBe(false)
  })

  it('has nothing to show for a file it never compiled', () => {
    const preview = model(BROKEN)
    const output = preview.output(URI, 'wgsl')
    expect(output?.text).toBe('')
    // Not stale: there is no previous output, and a panel that said "stale" with nothing behind
    // it would be claiming something it does not have.
    expect(output?.stale).toBe(false)
  })

  it('answers nothing at all for a document it does not hold', () => {
    expect(new PreviewModel().output(URI, 'wgsl')).toBeUndefined()
    expect(model().output('file:///p/other.shade.ts', 'wgsl')).toBeUndefined()
  })

  it('lists entries with the parameters the CPU oracle takes', () => {
    // From the declaration, not from `EntryInfo.io.inputs`: the reflection flattens `fs`'s struct
    // parameter into the struct's two fields, which does not line up with the one argument the
    // compiled function takes.
    const entries = model().entries(URI)
    expect(entries.map((entry) => entry.name)).toEqual(['vs', 'fs'])
    expect(entries[0].params.map((param) => param.name)).toEqual(['i'])
    expect(entries[1].params.map((param) => param.name)).toEqual(['input'])
    expect(entries[1].params[0].type).toEqual({ kind: 'struct', name: 'VsOut' })
  })

  it('lists no entries and offers no module while the file is broken', () => {
    const preview = model(BROKEN)
    expect(preview.entries(URI)).toEqual([])
    expect(preview.module(URI)).toBeUndefined()
  })

  it('forgets everything about a closed document', () => {
    const preview = model()
    preview.output(URI, 'wgsl')
    preview.closeDocument(URI)
    expect(preview.has(URI)).toBe(false)
    expect(preview.output(URI, 'wgsl')).toBeUndefined()

    // Re-opened broken, the stale text from before the close must not come back: it belongs to a
    // document this model no longer has.
    preview.setDocument(URI, BROKEN, 1)
    expect(preview.output(URI, 'wgsl')?.stale).toBe(false)
  })

  it('resolves an import through the host it was given', () => {
    const library = 'file:///p/lib.shade.ts'
    const texts = new Map([
      [library, '"use typeshade"\n\nexport function double(x: f32): f32 {\n  return x * 2.\n}\n'],
    ])
    const preview = new PreviewModel({ readDocument: (uri) => texts.get(uri) })
    preview.setDocument(
      URI,
      '"use typeshade"\n\nimport { double } from \'./lib.shade.js\'\n\n@fragment\nexport function fs(): f32 {\n  return double(2.)\n}\n',
      1,
    )
    // The module resolves, so nothing reports TS2307. The call itself still reads as unknown,
    // which is the compiler's own open item (`docs/language-service-api.md` §11) and the same
    // gap the plugin's suite asserts.
    const output = preview.output(URI, 'wgsl')
    expect(output?.diagnostics.map((d) => d.code)).not.toContain(2307)
  })
})
