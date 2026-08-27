import tseslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import prettier from 'eslint-plugin-prettier'
import { rules as eslintConfigPrettierRules } from 'eslint-config-prettier'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default [
  {
    ignores: [
      '**/dist/**',
      '**/*.d.ts',
      '**/node_modules/**',
      '**/.next/**',
      '**/coverage/**',
      'ci/audit/**',
      '.claude/**',
    ],
  },
  {
    rules: eslintConfigPrettierRules,
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.test.ts', 'lib/*.test.ts']
        },
        tsconfigRootDir: import.meta.dirname,
      },
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tseslint,
      prettier,
    },
    rules: {
      'prettier/prettier': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-warning-comments': 'error',
    },
  },
]
