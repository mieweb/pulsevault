// Flat ESLint config for the PulseVault server library.
// Mirrors the conventions enforced in the Pulse app: TypeScript-aware linting,
// a single type-import form (`import type { … }`), grouped/sorted imports, and
// Prettier-owned formatting (eslint-config-prettier disables stylistic rules).
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'examples/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Shared: Node globals everywhere.
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Library source: enforce grouped/sorted imports + a single type-import form.
    // NOTE: import sorting is intentionally NOT applied to test/*.mjs — side-effect
    // import ordering in test files (module-graft shims that must load before the
    // module they patch) would be silently broken by an automatic sort.
    files: ['src/**/*.ts'],
    plugins: {
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      'no-undef': 'off', // the TS compiler already resolves identifiers.
      'simple-import-sort/imports': [
        'error',
        {
          // node builtins → external packages → relative — the house grouping.
          groups: [['^node:', '^@?\\w'], ['^\\.']],
        },
      ],
      'simple-import-sort/exports': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        // Allow inline `typeof import('…')` annotations: s3.ts uses them for
        // optional peer deps (@aws-sdk/*, @tus/s3-store) that may not be installed,
        // where a top-level `import type` would break typecheck when absent.
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
          disallowTypeAnnotations: false,
        },
      ],
    },
  },
  prettier,
);
