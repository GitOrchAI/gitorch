import { expect, test } from 'vitest'
import {
  findActionsSemPin,
  findDuplicateKeys,
  findPnpmSetupComVersion,
  validateWorkflowsDir,
} from './validate-workflows.js'

test('detecta chave duplicada no mesmo bloco env (caso real: jules-pr-conflict.yml)', () => {
  const yaml = `jobs:
  x:
    steps:
      - name: step
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          SECURITY_PAT: \${{ secrets.SECURITY_PAT }}
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: echo ok
`
  const dups = findDuplicateKeys(yaml)
  expect(dups).toEqual([{ line: 8, key: 'GH_TOKEN' }])
})

test('nao acusa falso positivo em chaves de mesmo nome em blocos diferentes', () => {
  const yaml = `jobs:
  a:
    env:
      FOO: 1
  b:
    env:
      FOO: 2
`
  expect(findDuplicateKeys(yaml)).toEqual([])
})

test('nao interpreta texto dentro de run: | (bloco scalar) como chaves', () => {
  const yaml = `steps:
  - name: step
    run: |
      echo "FOO: bar"
      echo "FOO: baz"
    env:
      X: 1
`
  expect(findDuplicateKeys(yaml)).toEqual([])
})

test('detecta duplicata em lista de itens (ex.: steps com mesma env)', () => {
  const yaml = `env:
  A: 1
  B: 2
  A: 3
`
  expect(findDuplicateKeys(yaml)).toEqual([{ line: 4, key: 'A' }])
})

test('nao acusa falso positivo em "name" repetido entre steps de uma lista', () => {
  const yaml = `steps:
  - name: Checkout
    uses: actions/checkout@v4
  - name: Build
    run: echo build
`
  expect(findDuplicateKeys(yaml)).toEqual([])
})

// ESTADO REAL DA MAIN: cobre os tres portoes de uma vez (chave duplicada, pin
// de action e version: no pnpm/action-setup). Mesmo padrao do portao da raiz
// (check-root-drafts.test.ts) — o que o repositorio versiona HOJE tem que
// passar, senao o portao e' enfeite.
test('todos os workflows atuais do repo passam no portao', () => {
  const errors = validateWorkflowsDir('.github/workflows')
  expect(errors).toEqual([])
})

// Convencao escrita em .github/actions/setup-pnpm/action.yml: action externa e'
// fixada pelo SHA de 40 do commit, com a versao em comentario ao lado. Tag e'
// MUTAVEL — `pnpm/action-setup@v3`, que este repo ja usou, nem tag era: era uma
// BRANCH.
test('action externa presa a tag e acusada', () => {
  const yaml = `steps:
  - uses: actions/checkout@v4
`
  expect(findActionsSemPin(yaml)).toEqual([{ line: 2, uses: 'actions/checkout@v4' }])
})

test('action externa presa ao SHA de 40 passa', () => {
  const yaml = `steps:
  - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
`
  expect(findActionsSemPin(yaml)).toEqual([])
})

test('action interna nao precisa de pin: e caminho local do proprio commit', () => {
  const yaml = `steps:
  - uses: ./.github/actions/setup-pnpm
`
  expect(findActionsSemPin(yaml)).toEqual([])
})

test('uses: sem @ nenhum tambem e acusado', () => {
  const yaml = `steps:
  - uses: actions/checkout
`
  expect(findActionsSemPin(yaml)).toEqual([{ line: 2, uses: 'actions/checkout' }])
})

test('uses: dentro de comentario nao conta', () => {
  const yaml = `steps:
  # - uses: actions/checkout@v4
  - uses: ./.github/actions/setup-pnpm
`
  expect(findActionsSemPin(yaml)).toEqual([])
})

// O defeito que derrubou o pages.yml em todo run entre 11/09 e 13/09/2026,
// sempre no passo 2: "Multiple versions of pnpm specified". A action ja le
// `packageManager` do package.json; declarar de novo faz ela ABORTAR.
test('pnpm/action-setup com version: e acusado', () => {
  const yaml = `steps:
  - uses: pnpm/action-setup@v4
    with:
      version: 9
`
  expect(findPnpmSetupComVersion(yaml)).toEqual([4])
})

test('pnpm/action-setup sem version: passa', () => {
  const yaml = `steps:
  - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10
  - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
    with:
      node-version: 22.x
`
  expect(findPnpmSetupComVersion(yaml)).toEqual([])
})

// A varredura para no fim do passo: um `version:` que pertence a OUTRA action,
// mais abaixo, nao pode ser cobrado do pnpm/action-setup.
test('version: de outra action abaixo nao e atribuido ao pnpm/action-setup', () => {
  const yaml = `steps:
  - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10
  - uses: outra/action@abcdef
    with:
      version: 3
`
  expect(findPnpmSetupComVersion(yaml)).toEqual([])
})
