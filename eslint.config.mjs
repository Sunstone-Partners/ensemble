// ESLint flat config for the whole ensemble-plugins monorepo.
//
// This is deliberately syntactic-only (no type-checked `strictTypeChecked`
// rules): the repo has dozens of packages each with their own tsconfig.json,
// and wiring project-aware linting across all of them is a separate effort.
// reviewdog runs this in `filter_mode: added`, so only lines touched by a PR
// are ever reported -- pre-existing violations across 100+ TS files and the
// many example/template files under packages/*/skills are never flagged.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  process: 'readonly',
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  __dirname: 'readonly',
  __filename: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  global: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  fetch: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
};

const jestGlobals = {
  describe: 'readonly',
  it: 'readonly',
  test: 'readonly',
  expect: 'readonly',
  jest: 'readonly',
  beforeEach: 'readonly',
  afterEach: 'readonly',
  beforeAll: 'readonly',
  afterAll: 'readonly',
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/lib/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '.beads/**',
      '.wiki-staging/**',
      '.refinement-review/**',
      '.session-backup/**',
      'marketplace.json',
      '**/*.min.js',
      '**/*.d.ts',
      '**/fixtures/**',
      '**/__snapshots__/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [...tseslint.configs.recommended],
  },
  {
    languageOptions: {
      globals: { ...nodeGlobals, ...jestGlobals },
    },
    rules: {
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
  {
    // Generator/scaffold scripts intentionally leave unused destructured
    // args in template literals and handler signatures. Base `no-unused-vars`
    // is disabled here so it doesn't double-report alongside the TS rule.
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs', '**/*.jsx'],
    rules: {
      'no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
