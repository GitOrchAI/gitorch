import { describe, it, expect } from 'vitest'
import { linkedIssueNumbers, hasActiveJulesSession } from './pr-eligibility.js'

describe('linkedIssueNumbers', () => {
  it('extrai de Fixes #N', () => {
    expect(linkedIssueNumbers('Fixes #179 e tal')).toEqual([179])
  })
  it('extrai de varias palavras-chave', () => {
    expect(linkedIssueNumbers('closes #1, resolves #2, fixed #3').sort()).toEqual([1, 2, 3])
  })
  it('extrai de URL de issue', () => {
    expect(linkedIssueNumbers('ver https://github.com/loureng/gitorch/issues/42')).toEqual([42])
  })
  it('deduplica', () => {
    expect(linkedIssueNumbers('fixes #5 e closes #5')).toEqual([5])
  })
  it('vazio sem referencias', () => {
    expect(linkedIssueNumbers('PR sem referencia a issue')).toEqual([])
  })
})

describe('hasActiveJulesSession', () => {
  it('true para PR aberto pelo Jules (tem o marcador no corpo)', () => {
    expect(
      hasActiveJulesSession({
        body: 'Corrige X.\n\n---\n*PR created automatically by Jules for task 123 started by @loureng*',
      })
    ).toBe(true)
  })
  it('false para PR puro do Dependabot (caso real do #213 - bump de @types/node)', () => {
    expect(
      hasActiveJulesSession({
        body: 'Bumps [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) from 20.10.0 to 26.1.0.',
      })
    ).toBe(false)
  })
  it('false para corpo vazio/nulo', () => {
    expect(hasActiveJulesSession({ body: null })).toBe(false)
    expect(hasActiveJulesSession({})).toBe(false)
  })
})
