// === The plugin's entry in VS Code for the Web ===
//
// The web extension host loads a plugin's `browser` field as an ES module and calls its DEFAULT
// export (`tsserver.web.js` does `(await import(url)).default`; the probe of
// `docs/measurements/web-plugin-load/` found `default` undefined when the module only had a
// named `init`). `index.ts` is the desktop entry and exports the factory as CommonJS, which the
// web host cannot load, so this file is the one line that exports the same plugin as a default.
//
// It asks for `readFrom: 'serverHost'` because that is the reader measured to answer inside the
// web worker: it returns the text on a cross-origin isolated page and undefined without
// isolation. In TypeScript 5.6.3 and 6.0.3 the two readers are the same function
// (`Project.readFile` is `projectService.host.readFile`), so the desktop entry keeps
// `languageServiceHost.readFile` and nothing about it changes. This module must stay free of
// Node imports: a browser bundle has no `process`, `Buffer` or `require`.

import type ts from 'typescript';
import { createPlugin } from './index.js';

/**
 * The plugin factory the web tsserver calls.
 *
 * @param modules - the modules the server shares with its plugins.
 * @returns the plugin object, reading files through `serverHost`.
 */
export default function init(modules: { readonly typescript: typeof ts }): ts.server.PluginModule {
  return createPlugin(modules, { readFrom: 'serverHost' });
}
