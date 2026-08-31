import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'

test('audit summary references required reports', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
  const action = readFileSync('.github/actions/upload-ci-audit/action.yml', 'utf8')
  expect(ci).toContain('./.github/actions/upload-ci-audit')
  // O que este teste protege e' que os relatorios de auditoria REALMENTE sobem:
  // que o CI chama o composite, que o composite usa a action de upload e que ela
  // aponta para o diretorio dos relatorios. Antes a segunda asserticao cobrava
  // `actions/upload-artifact@v4` — a TAG, nao a action. Isso congelou a convencao
  // velha: quando o repositorio passou a fixar action externa por SHA de 40
  // (ver .github/actions/setup-pnpm/action.yml), o texto `@v4` sumiu do YAML e o
  // teste reprovou a propria mudanca que ele deveria acompanhar. Cobrar a versao
  // e' errado por construcao aqui: com pin por SHA a versao vive no comentario,
  // e um major novo nao e' regressao. Cobramos entao a action CERTA pelo caminho,
  // mais o formato do pin — o que faz este teste proteger a convencao NOVA.
  expect(action).toContain('actions/upload-artifact@')
  expect(action).toMatch(/actions\/upload-artifact@[0-9a-f]{40}\b/)
  expect(action).toContain('ci/audit/**')
})
