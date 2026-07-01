import { describe, it, expect } from 'vitest'
import { linkedIssueNumbers } from './pr-eligibility.js'

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
