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
  // A terceira asserticao cobrava `github/codeql-action/analyze@v4` — a TAG.
  // O que ela protege de fato e' que o passo de ANALISE do CodeQL continua no
  // workflow: sem ele o `init` sozinho nao reporta nada e o scan vira enfeite.
  // A versao nunca foi o ponto, e cobrar tag e' incompativel com a convencao
  // de fixar action externa por SHA de 40 (a versao passa a viver no comentario
  // ao lado do pin). Cobramos a action pelo caminho + o formato do pin: assim o
  // teste barra tanto quem remover o `analyze` quanto quem voltar a usar tag
  // mutavel, sem reprovar uma subida legitima de versao.
  expect(codeql).toContain('github/codeql-action/analyze@')
  expect(codeql).toMatch(/github\/codeql-action\/analyze@[0-9a-f]{40}\b/)
})
