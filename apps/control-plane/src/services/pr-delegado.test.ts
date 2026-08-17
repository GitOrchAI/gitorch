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
    pendingSince: null,
    mergeCommitSha: null,
    deployState: null,
    deployCheckedAt: null,
    mergeFailures: 0,
    mergeLastFailedAt: null,
    closedAt: null,
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

  it('recua para a palavra de ligação + etiqueta na issue, quando existe sessão para aquela issue', () => {
    // O caminho 3 só se sustenta com a sessão por trás (ver comentário no
    // topo do módulo, caso real do PR #99) — sem ela, texto no corpo + label
    // não provam delegação. Este teste cobre o cenário LEGÍTIMO: a issue #74
    // foi de fato delegada (existe linha), e o PR ainda não tem `pullRequestNumber`
    // gravado (é assim que o caminho 1 fica cego e o 3 precisa decidir).
    expect(
      ehPrDelegado({
        numeroDoPr: 79,
        autor: 'loureng',
        corpo: 'Closes #74\n\nresumo',
        sessoes: [linha({ issueNumber: 74, pullRequestNumber: null })],
        issueComEtiquetaDeDelegacao: (n) => n === 74,
      })
    ).toEqual({ delegado: true, issueNumber: 74 })
  })

  it('NÃO reconhece PR humano que só CITA a issue delegada, sem sessão para ela (caso real do PR #99)', () => {
    // Caso real, medido em produção 15/08/2026: PR #99, autor `loureng`
    // (humano, correção minha), com a linha "Fixes #74" no corpo — mas ao
    // DESCREVER um defeito, não como intenção de fechar a issue. A issue #74
    // carrega a etiqueta de delegação, mas #74 NUNCA foi delegada ao dev
    // assíncrono — não existe linha em `dev_sessions` para ela (confirmado:
    // `select count(*) from dev_sessions where pull_request_number = 99` → 0).
    //
    // Resultado medido antes desta correção: "QA judged PR #99: request_changes
    // (CI pending)" — o QA julgou o PR humano como entrega do dev assíncrono.
    // Só não mesclou porque a verificação ainda rodava; com CI verde e
    // aprovação, o produto teria mesclado um PR humano sozinho.
    expect(
      ehPrDelegado({
        numeroDoPr: 99,
        autor: 'loureng',
        corpo:
          'Ao investigar o comportamento, achei que a causa raiz é a mesma relatada ' +
          'em Fixes #74, só que manifestada de outra forma neste fluxo.',
        sessoes: [],
        issueComEtiquetaDeDelegacao: (n) => n === 74,
      })
    ).toEqual({ delegado: false, issueNumber: null })
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
