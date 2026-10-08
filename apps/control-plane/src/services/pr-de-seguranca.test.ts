import { describe, expect, it } from 'vitest'
import {
  ehPrDeSeguranca,
  MARCA_DO_PR_DE_SEGURANCA,
  PREFIXO_DOS_RAMOS_DE_SEGURANCA,
} from './pr-de-seguranca.js'

describe('ehPrDeSeguranca: o pull request do aplicador de segurança é inequívoco', () => {
  it('o ramo com o prefixo do GitOrch identifica o pull request', () => {
    expect(ehPrDeSeguranca({ ramo: `${PREFIXO_DOS_RAMOS_DE_SEGURANCA}permissoes-ci-yml` })).toBe(
      true
    )
    expect(ehPrDeSeguranca({ ramo: 'gitorch/seguranca/desfazer-alternativa' })).toBe(true)
  })

  it('o prefixo vale sem diferença de caixa (o lado seguro é não mesclar)', () => {
    expect(ehPrDeSeguranca({ ramo: 'GitOrch/Seguranca/x' })).toBe(true)
  })

  it('a marca no corpo identifica o pull request mesmo sem o ramo', () => {
    expect(
      ehPrDeSeguranca({ ramo: null, corpo: `${MARCA_DO_PR_DE_SEGURANCA}\n\n## O que muda` })
    ).toBe(true)
    expect(ehPrDeSeguranca({ corpo: `texto\n<!--  gitorch:seguranca  -->\nmais texto` })).toBe(true)
  })

  it.each([
    [{ ramo: 'feature/x', corpo: 'Closes #3' }],
    [{ ramo: 'gitorch/seguranca', corpo: '' }],
    [{ ramo: 'feature/gitorch/seguranca/x', corpo: null }],
    [{ ramo: 'gitorch/outra-coisa/x' }],
    [{ ramo: null, corpo: null }],
    [{}],
  ])('um pull request comum não é de segurança: %j', (pr) => {
    expect(ehPrDeSeguranca(pr)).toBe(false)
  })
})
