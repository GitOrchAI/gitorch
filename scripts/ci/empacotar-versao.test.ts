import { spawnSync } from 'node:child_process'
import { expect, test } from 'vitest'

// O empacotador é um script de shell; o teste dele também. Este arquivo só o
// liga ao `vitest run --dir scripts` (passo "Testes dos scripts que governam o
// CI"), que é o lugar onde o CI já roda os testes de scripts da pasta.
test('empacotar-versao.sh empacota, confere a soma e recusa entradas inválidas', () => {
  const r = spawnSync('bash', ['scripts/ci/empacotar-versao.test.sh'], { encoding: 'utf8' })
  expect(r.stderr).not.toMatch(/FALHA/)
  expect(r.status).toBe(0)
  expect(r.stdout).toContain('falhas: 0')
}, 60_000)
