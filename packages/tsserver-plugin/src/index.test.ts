import { describe, expect, it } from 'vitest'
import typescript from 'typescript'
import type ts from 'typescript'
import { init } from './index.js'
import { testCreateInfo, testProject } from './testing.js'

const SHADER = `"use typeshade"

@fragment
export function fs(): f32 {
  return 1.
}
`

describe('the plugin entry point', () => {
  it('is a callable factory, which is the shape tsserver requires', () => {
    // tsserver `require`s the package main and calls the module object itself. An export that
    // is a namespace object rather than a function loads without an error and then never runs,
    // so the callable shape is worth a test of its own. `scripts/build.mjs` is what makes the
    // bundle's `module.exports` this function, and `build.test.ts` checks the built artifact.
    expect(typeof init).toBe('function')
  })

  it('decorates the project service and says so in the log', () => {
    const project = testProject({ '/project/a.shade.ts': SHADER })
    const { info, logged } = testCreateInfo(project)
    const decorated = init({ typescript }).create(info)
    expect(decorated).not.toBe(project.service)
    expect(logged.some((line) => line.includes('plugin loaded'))).toBe(true)
    expect(logged.some((line) => line.includes('decorated'))).toBe(true)
  })

  it('falls back to the project service when decoration throws', () => {
    // A plugin that throws out of `create` takes the project's TypeScript with it, so this
    // fallback is the difference between losing TypeShade support and losing the editor.
    const project = testProject({ '/project/a.shade.ts': SHADER })
    const exploding = new Proxy(project.service, {
      get() {
        throw new Error('boom')
      },
    })
    const { info, logged } = testCreateInfo(project)
    const broken = { ...info, languageService: exploding } as unknown as ts.server.PluginCreateInfo
    expect(init({ typescript }).create(broken)).toBe(exploding)
    expect(logged.some((line) => line.includes('decoration failed'))).toBe(true)
  })
})
