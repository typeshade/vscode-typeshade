// === typeshade-tsserver-plugin: the plugin entry point tsserver loads ===
//
// tsserver `require`s this module and calls the exported factory once per project that names
// the plugin, then uses the `LanguageService` the factory returns in place of its own. This
// file is the pass-through skeleton: it takes the host's own `typescript` module and language
// service and hands the service straight back, which is the shape every later decoration is
// added to (see `docs/design.md` §3 for the method table).
//
// The file exports the factory with `export =` because that is what tsserver calls: it
// `require`s the package `main` and invokes the module object itself. An export assignment
// cannot share a module with named exports, so every type this file needs is imported, never
// re-exported from here.

// Types from `typescript`, not from `typescript/lib/tsserverlibrary`: the server-side
// declarations (`ts.server.PluginModule`, `ts.server.PluginCreateInfo`, `ts.server.Project`)
// have been in the main `typescript.d.ts` since 5.0, and the `tsserverlibrary` entry point is
// a deprecated re-export that a future TypeScript may drop. A type-only import, so nothing
// here pins a `typescript` instance at runtime.
import type ts from 'typescript'

/**
 * The plugin factory tsserver calls. `modules.typescript` is the server's own `typescript`
 * module, and it is the only one the plugin may use: a plugin that imported `typescript`
 * itself would build nodes with a different `ts` instance than the host's program, and every
 * `ts.is*` check would then answer about the wrong syntax kinds.
 *
 * @param modules - the modules tsserver shares with its plugins.
 * @returns the plugin object tsserver uses, whose `create` returns the service for a project.
 */
function init(modules: { readonly typescript: typeof ts }): ts.server.PluginModule {
  return {
    create(info: ts.server.PluginCreateInfo): ts.LanguageService {
      info.project.projectService.logger.info(
        `[typeshade] plugin loaded (typescript ${modules.typescript.version})`,
      )
      return info.languageService
    },
  }
}

export = init
