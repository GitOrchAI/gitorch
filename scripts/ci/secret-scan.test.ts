import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'

test('security workflow includes CodeQL and gitleaks', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
  const codeql = readFileSync('.github/workflows/codeql-analysis.yml', 'utf8')
  // PR #11 tirou a Action gitleaks/gitleaks-action (exige cadastro de
  // organizacao) e passou a instalar o binario oficial direto no runner —
  // este teste nunca rodou de verdade em CI, entao ninguem percebeu que ele
  // ainda cobrava a Action antiga. Cobrar o binario pinado mantem o teste
  // util: se alguem trocar de ferramenta de novo sem atualizar aqui, falha.
  expect(ci).toContain('gitleaks_${{ env.GITLEAKS_VERSION }}_linux_x64.tar.gz')
  expect(ci).toContain('gitleaks detect --source .')
  expect(codeql).toContain('github/codeql-action/analyze@v4')
})
