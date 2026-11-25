/**
 * ESLint 9 flat config for @irexpro/api (CommonJS format).
 *
 * Migrated from the legacy `.eslintrc.js` to the ESLint 9 flat config format.
 * Preserves the EXACT effective lint behavior of the legacy config.
 *
 * The legacy `.eslintrc.js` extended:
 *   - plugin:@typescript-eslint/recommended
 *       (which internally extends eslint-recommended, disabling core rules that
 *       conflict with TypeScript, and adds TypeScript-specific recommended rules)
 *   - plugin:prettier/recommended
 *       (which applies eslint-config-prettier to disable conflicting formatting
 *       rules, and enables the prettier/prettier rule at 'error')
 *
 * It did NOT extend eslint:recommended.
 *
 * No eslint:recommended / @eslint/js recommended is included — it was NOT part
 * of the legacy effective configuration.
 */
const tseslint = require('@typescript-eslint/eslint-plugin');
const prettierConfig = require('eslint-config-prettier');
const prettierPlugin = require('eslint-plugin-prettier');
const globals = require('globals');

module.exports = [
  // ── @typescript-eslint/recommended (flat config) ────────────────────────
  // This array includes:
  //   [0] parser (@typescript-eslint/parser) + plugin (@typescript-eslint) registration
  //   [1] TypeScript recommended rules for **/*.ts files
  //   [2] eslint-recommended disables (no-unused-vars: off, no-undef: off, etc.)
  ...tseslint.configs['flat/recommended'],

  // ── Parser options + globals (from legacy .eslintrc.js) ─────────────────
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: 'tsconfig.eslint.json',
        tsconfigRootDir: __dirname,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
  },

  // ── Prettier (reproduces plugin:prettier/recommended) ───────────────────
  {
    files: ['**/*.ts'],
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      ...prettierConfig.rules,
      'prettier/prettier': 'error',
    },
  },

  // ── Custom rules (preserved verbatim from legacy .eslintrc.js) ──────────
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
    },
  },

  // ── Ignores (migrated from legacy ignorePatterns) ───────────────────────
  {
    ignores: ['.eslintrc.js', 'dist/**', 'node_modules/**'],
  },
];
