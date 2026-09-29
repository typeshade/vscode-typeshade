// Flat config. `typescript-eslint`'s recommended set plus the two rules this repository states
// as conventions of its own: no `any`, and an unused symbol is an error rather than a warning
// (the compiler options already fail on unused locals and parameters, so this only adds the
// same rule for the cases `tsc` does not see, such as an unused caught error).
import { builtinModules } from 'node:module';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // The electron suite's fixture is a shader, not TypeScript this repository writes: linting
    // it would report the same false positives the plugin exists to remove.
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/node_modules/**',
      'vendor/**',
      'coverage/**',
      // The VS Code build the electron job downloads, 327 MB of someone else's JavaScript.
      '.vscode-test/**',
      'packages/vscode-typeshade/test-electron/fixture/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': 'error',
      // `ignoreReadBeforeAssign` is on because two objects here refer to each other: the
      // TypeShade service asks for an imported file through a callback, and the document sync
      // that answers it needs the service. The callback is created before the sync exists, so
      // the binding is genuinely read before it is assigned and cannot be a `const`.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },
  {
    // The files that run in a browser worker, in VS Code for the Web: the extension's web entry,
    // the decisions it makes, and the plugin's web entry. Each package's `tsconfig` has Node's
    // types, so `tsc` accepts `node:zlib` or `Buffer` here and the failure would come only at run
    // time, in a worker with no `process`. A Node import is refused instead, by its `node:` name
    // and by the bare built-in names (`fs`, `path`, ...), and `web-build.test.ts` and
    // `build-web.test.ts` load the bundles with those globals gone.
    files: [
      'packages/vscode-typeshade/src/extension.web.ts',
      'packages/vscode-typeshade/src/web-support.ts',
      'packages/tsserver-plugin/src/web.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: builtinModules
            .filter((name) => !name.startsWith('_'))
            .map((name) => ({
              name,
              message: 'This file runs in a browser worker, which has no Node built-in modules.',
            })),
          patterns: [
            {
              group: ['node:*'],
              message: 'This file runs in a browser worker, which has no Node built-in modules.',
            },
          ],
        },
      ],
    },
  },
);
