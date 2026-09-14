import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import typescript from 'typescript'

const require = createRequire(import.meta.url)
const BUNDLE = fileURLToPath(new URL('../dist/index.js', import.meta.url))

describe('the built bundle', () => {
  it('exports the factory itself, which is what tsserver calls', () => {
    // esbuild emits ESM exports as a namespace object, and a namespace object is not callable,
    // so `scripts/build.mjs` adds the line that makes `module.exports` the factory. A plugin
    // with the wrong export loads without an error and then never runs, which is exactly the
    // failure this catches. `npm run build` must have run: `npm run check` does it first.
    expect(existsSync(BUNDLE), `${BUNDLE} is missing; run npm run build`).toBe(true)
    const loaded: unknown = require(BUNDLE)
    expect(typeof loaded).toBe('function')
    const plugin = (loaded as (m: { typescript: typeof typescript }) => { create?: unknown })({
      typescript,
    })
    expect(typeof plugin.create).toBe('function')
  })
})
