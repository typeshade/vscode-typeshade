// Tests live beside the code they cover, in each package's own `src/`.
//
// Named `.mts` because `vitest/config` is ESM only and the root package is not an ESM package.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** The compiler's published specifiers, resolved to the pinned submodule, exactly as
 *  `tsconfig.base.json` `paths` and `scripts/build.mjs` do it. Three places need the mapping
 *  because three tools resolve modules; they are kept identical so a test never runs against a
 *  different compiler than the build. The array form is ordered, so the subpaths come first. */
const vendor = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: 'typeshade/language-service',
        replacement: vendor('./vendor/typeshade/src/language-service/index.ts'),
      },
      { find: 'typeshade/debug', replacement: vendor('./vendor/typeshade/src/debug.ts') },
      { find: /^typeshade$/, replacement: vendor('./vendor/typeshade/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // A tsserver-level test spawns a real `tsserver.js` and drives its protocol over stdio, so
    // the default 5 s is too tight for the first request of a run, which pays for the server's
    // own start-up plus the first program build.
    testTimeout: 30_000,
  },
});
