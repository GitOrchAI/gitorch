import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

// Regressao do defeito de 21/08/2026: `core.hooksPath` aponta para `.husky/_`,
// que e GERADO pelo script `prepare` e nao nasce com um `git worktree add`.
// Sem esses arquivos versionados, o git nao encontra hook nenhum na worktree e
// o commit passa em silencio — sem lint, sem typecheck, sem teste. Foi assim
// que 2 erros de prettier derrubaram o check zero-tolerance do PR #135.
//
// Este teste falha se alguem tirar o portao do controle de versao de novo.

function isTracked(path: string): boolean {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', path], {
    encoding: 'utf8',
  })
  return result.status === 0
}

test.each(['.husky/pre-commit', '.husky/_/pre-commit', '.husky/_/h'])(
  '%s esta versionado, senao o portao some em worktree nova',
  (path) => {
    expect(isTracked(path)).toBe(true)
  }
)

test('o ponto de entrada em .husky/_ delega para o portao real', () => {
  const entrada = readFileSync('.husky/_/pre-commit', 'utf8')
  expect(entrada).toContain('/h')

  const dispatcher = readFileSync('.husky/_/h', 'utf8')
  // O dispatcher monta o caminho do portao real subindo um nivel de `_`.
  expect(dispatcher).toContain('dirname')
})

test('o portao nao mascara falha: sem `|| true`, sem `continue-on-error`', () => {
  const portao = readFileSync('.husky/pre-commit', 'utf8')
  expect(portao).not.toMatch(/\|\|\s*true/)
  expect(portao).not.toContain('continue-on-error')
  expect(portao).toContain('set -e')
})

test('o portao roda os tres gates', () => {
  const portao = readFileSync('.husky/pre-commit', 'utf8')
  expect(portao).toContain('lint-staged')
  expect(portao).toContain('typecheck:strict')
  expect(portao).toContain('pnpm run test')
})

test('sem node_modules o portao barra o commit em vez de deixar passar', () => {
  // Roda o hook num diretorio vazio: nao ha node_modules, entao ele tem que
  // sair diferente de zero e explicar o que fazer.
  const result = spawnSync('sh', [`${process.cwd()}/.husky/pre-commit`], {
    cwd: '/',
    encoding: 'utf8',
    env: { ...process.env, HUSKY: '0' },
  })
  expect(result.status).not.toBe(0)
  expect(result.stdout).toContain('PORTAO DE PRE-COMMIT BLOQUEADO')
})
