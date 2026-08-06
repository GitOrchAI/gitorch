import tseslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import prettier from 'eslint-plugin-prettier'
import { rules as eslintConfigPrettierRules } from 'eslint-config-prettier'

export default [
  {
    ignores: [
      '**/dist/**',
      '**/*.d.ts',
      '**/node_modules/**',
      '**/.next/**',
      '**/coverage/**',
      'ci/audit/**',
      // Worktrees de sessões de agente vivem ANINHADOS em .claude/worktrees/ e
      // não fazem parte do repositório (o git nem os rastreia). Sem este
      // ignore, uma verificação local reprova por causa de código de outra
      // branch — vermelho falso que não existe no CI, onde o checkout é limpo.
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
        projectService: true,
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
