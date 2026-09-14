import { describe, expect, it } from 'vitest'
import type ts from 'typescript/lib/tsserverlibrary'
import typescript from 'typescript'
import init from './index.js'

/** The parts of `ts.server.PluginCreateInfo` the plugin factory actually touches. A real one
 *  carries a project, a projectService and a server host, none of which exist outside
 *  tsserver; the factory is written so that this much is enough. */
function fakeCreateInfo(languageService: ts.LanguageService): ts.server.PluginCreateInfo {
  const logged: string[] = []
  return {
    languageService,
    project: { projectService: { logger: { info: (s: string) => logged.push(s) } } },
  } as unknown as ts.server.PluginCreateInfo
}

describe('the plugin entry point', () => {
  it('is a callable factory, which is the shape tsserver requires', () => {
    // tsserver `require`s the package main and calls the module object itself. An `export
    // default` here would load without an error and then never run, so the callable shape is
    // worth a test of its own.
    expect(typeof init).toBe('function')
  })

  it('returns the host language service unchanged, for now', () => {
    const service = {} as ts.LanguageService
    const plugin = init({ typescript: typescript as unknown as typeof ts })
    expect(plugin.create(fakeCreateInfo(service))).toBe(service)
  })
})
