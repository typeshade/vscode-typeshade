// Tests live beside the code they cover, in each package's own `src/`.
//
// Named `.mts` because the root package is CommonJS (`module: node16`, no `"type": "module"`)
// and `vitest/config` is ESM only: a `.ts` config here is compiled as CommonJS and cannot
// `require` it, which is TS1479.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // A tsserver-level test spawns a real `tsserver.js` and drives its protocol over stdio, so
    // the default 5 s is too tight for the first request of a run, which pays for the server's
    // own start-up plus the first program build.
    testTimeout: 30_000,
  },
})
