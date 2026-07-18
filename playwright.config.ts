import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  // E2Es que exigem BANCO REAL só são coletados onde existe banco.
  //
  // O e2e-wizard.yml sobe um serviço de Postgres, exporta DATABASE_URL no job e
  // chama estes specs pelo nome — lá eles rodam de verdade. Já o runner genérico
  // (`pnpm run e2e`, no zero-tolerance) não tem banco nenhum: coletar o spec ali
  // é erro de categoria — ele morre no beforeAll por falta de DATABASE_URL sem
  // nunca ter tido chance de rodar, e derruba a CI inteira.
  //
  // O gate é a PRESENÇA do banco, não um nome de job: onde há DATABASE_URL o
  // spec é coletado (e continua EXIGINDO o resto da infra com throw, como o autor
  // dele quis — um E2E que se auto-pula no job certo não guardaria nada); onde
  // não há, ele nem entra na lista. Um `testIgnore` incondicional seria pior que
  // o bug: ele apagaria o spec TAMBÉM do e2e-wizard.yml (o `--list` por nome
  // devolve 0 testes), desligando em silêncio justamente a guarda que ele é.
  testIgnore: process.env['DATABASE_URL'] ? [] : ['**/setup-wizard-fluxo-completo.spec.ts'],
  use: {
    headless: true,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  reporter: [['html', { outputFolder: 'playwright-report', open: 'never' }]],
})
