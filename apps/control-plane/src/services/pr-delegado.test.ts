import { describe, it, expect } from 'vitest'
import { ehPrDelegado } from './pr-delegado.js'
import type { LinhaDeSessao } from './dev-session-store.js'

function linha(over: Partial<LinhaDeSessao>): LinhaDeSessao {
  return {
    id: 'x',
    projectId: 'p',
    issueNumber: 1,
    sessionName: 's',
    state: 'COMPLETED',
    answeredHash: null,
    pullRequestNumber: null,
    attempts: 1,
    nudges: 0,
    lastProgressAt: null,
    stateCheckedAt: null,
    ...over,
  }
}

describe('ehPrDelegado', () => {
  it('reconhece pela linha, mesmo com autor da instalação e sem palavra de ligação', () => {
    // Caso real do PR #63: autor `loureng`, corpo sem `Closes #N`.
    expect(
      ehPrDelegado({
        numeroDoPr: 63,
        autor: 'loureng',
        corpo: 'Fix failing CI by downgrading action versions',
        sessoes: [linha({ issueNumber: 24, pullRequestNumber: 63 })],
        issueComEtiquetaDeDelegacao: () => false,
      })
    ).toEqual({ delegado: true, issueNumber: 24 })
  })

  it('recua para o login do autor quando não há linha', () => {
    expect(
      ehPrDelegado({
        numeroDoPr: 9,
        autor: 'google-labs-jules[bot]',
        corpo: '',
        sessoes: [],
        issueComEtiquetaDeDelegacao: () => false,
      })
    ).toEqual({ delegado: true, issueNumber: null })
  })

  it('recua para a palavra de ligação + etiqueta na issue', () => {
    expect(
      ehPrDelegado({
        numeroDoPr: 79,
        autor: 'loureng',
        corpo: 'Closes #74\n\nresumo',
        sessoes: [],
        issueComEtiquetaDeDelegacao: (n) => n === 74,
      })
    ).toEqual({ delegado: true, issueNumber: 74 })
  })

  it('não reconhece PR de humano sem nada disso', () => {
    expect(
      ehPrDelegado({
        numeroDoPr: 5,
        autor: 'alguem',
        corpo: 'ajuste manual',
        sessoes: [],
        issueComEtiquetaDeDelegacao: () => false,
      })
    ).toEqual({ delegado: false, issueNumber: null })
  })

  it('a linha ganha da palavra de ligação quando as duas existem', () => {
    expect(
      ehPrDelegado({
        numeroDoPr: 63,
        autor: 'loureng',
        corpo: 'Closes #99',
        sessoes: [linha({ issueNumber: 24, pullRequestNumber: 63 })],
        issueComEtiquetaDeDelegacao: () => true,
      })
    ).toEqual({ delegado: true, issueNumber: 24 })
  })
})
