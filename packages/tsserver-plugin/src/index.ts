// === @typeshade/tsserver-plugin: the plugin entry point tsserver loads ===
//
// tsserver `require`s this module and calls the module object itself, once per project that
// names the plugin, then uses the `LanguageService` it returns in place of the project's own.
// `scripts/build.mjs` is what makes the bundle's `module.exports` this function: esbuild emits
// ESM exports as a namespace object, and a namespace object is not callable, so the build adds
// the one line that assigns the factory. `index.test.ts` and the tsserver test both check the
// shape, because the failure mode is a plugin that loads without an error and never runs.

import type ts from 'typescript';
import { decorate } from './decorate.js';

/**
 * The plugin factory tsserver calls.
 *
 * @param modules - the modules tsserver shares with its plugins. `modules.typescript` is the
 *   server's own `typescript`, and it is the only one the plugin may use: a second instance
 *   would build nodes with a different `ts`, and every `ts.is*` check would then answer about
 *   the wrong syntax kinds.
 * @returns the plugin object tsserver uses, whose `create` returns the service for a project.
 */
export function init(modules: { readonly typescript: typeof ts }): ts.server.PluginModule {
  return {
    create(info: ts.server.PluginCreateInfo): ts.LanguageService {
      const logger = info.project.projectService.logger;
      const log = (message: string): void => {
        logger.info(message);
      };
      log(`[typeshade] plugin loaded (typescript ${modules.typescript.version})`);
      try {
        return decorate(info, modules.typescript, log);
      } catch (error) {
        // A plugin that throws here takes the project's TypeScript with it. Falling back to the
        // undecorated service costs TypeShade support and keeps everything else working, which
        // is the right way round; the message names the plugin so the log is searchable.
        const message = error instanceof Error ? error.message : String(error);
        log(`[typeshade] decoration failed, passing through: ${message}`);
        return info.languageService;
      }
    },
  };
}
