import { expect, test } from 'vitest'
import { findDuplicateKeys, validateWorkflowsDir } from './validate-workflows.js'

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

test('todos os workflows atuais do repo estao sem chaves duplicadas', () => {
  const errors = validateWorkflowsDir('.github/workflows')
  expect(errors).toEqual([])
})
