// Flat config. `typescript-eslint`'s recommended set plus the two rules this repository states
// as conventions of its own: no `any`, and an unused symbol is an error rather than a warning
// (the compiler options already fail on unused locals and parameters, so this only adds the
// same rule for the cases `tsc` does not see, such as an unused caught error).
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/out/**', '**/node_modules/**', 'vendor/**', 'coverage/**'],
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
);
