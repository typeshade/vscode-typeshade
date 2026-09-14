// Flat config. `typescript-eslint`'s recommended set plus the two rules this repository states
// as conventions of its own: no `any`, and an unused symbol is an error rather than a warning
// (the compiler options already fail on unused locals and parameters, so this only adds the
// same rule for the cases `tsc` does not see, such as an unused caught error).
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/out/**', '**/node_modules/**', 'vendor/**', 'coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': 'error',
    },
  },
)
