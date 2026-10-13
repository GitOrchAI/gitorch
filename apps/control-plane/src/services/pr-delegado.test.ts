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
    reworkNoticePending: null,
    reworkNoticeAttempts: 0,
    pendingSince: null,
    mergeCommitSha: null,
    deployState: null,
    deployCheckedAt: null,
    mergeFailures: 0,
    mergeLastFailedAt: null,
    deployFixKey: null,
    envLastVerdict: null,
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

  it('o fechamento formal do GitHub (closingIssuesReferences) ganha da menção solta', () => {
    expect(
      ehPrDelegado({
        numeroDoPr: 63,
        autor: 'loureng',
        corpo: 'Closes #99',
        sessoes: [],
        issueComEtiquetaDeDelegacao: (n) => n === 10,
        closingIssuesReferences: [10],
      })
    ).toEqual({ delegado: true, issueNumber: 10 })
  })

  it('fechamento formal do GitHub (closingIssuesReferences) é ignorado se não tem etiqueta de delegação', () => {
    expect(
      ehPrDelegado({
        numeroDoPr: 63,
        autor: 'loureng',
        corpo: '',
        sessoes: [],
        issueComEtiquetaDeDelegacao: () => false,
        closingIssuesReferences: [10],
      })
    ).toEqual({ delegado: false, issueNumber: null })
  })
})

// PR de participante do repositório é atendido como o do dev delegado. A
// autoria vem do campo do GitHub (`author_association`) — nunca do texto.
describe('ehPrDelegado — participante do repositório', () => {
  const base = {
    numeroDoPr: 120,
    autor: 'colega-da-equipe',
    corpo: 'ajuste do colega',
    sessoes: [] as LinhaDeSessao[],
    issueComEtiquetaDeDelegacao: () => false,
  }

  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])(
    'PR de %s, sem linha de sessão, é julgável e marcado como de participante',
    (associacao) => {
      expect(ehPrDelegado({ ...base, authorAssociation: associacao })).toEqual({
        delegado: true,
        issueNumber: null,
        origem: 'participante',
        associacao,
      })
    }
  )

  it('a associação sai normalizada em maiúscula, para quem decide a mescla comparar sem surpresa', () => {
    expect(ehPrDelegado({ ...base, authorAssociation: 'owner' })).toEqual({
      delegado: true,
      issueNumber: null,
      origem: 'participante',
      associacao: 'OWNER',
    })
  })

  it.each(['CONTRIBUTOR', 'NONE', 'FIRST_TIME_CONTRIBUTOR', 'MANNEQUIN', '', undefined])(
    'PR de %s continua NÃO delegado',
    (associacao) => {
      expect(ehPrDelegado({ ...base, authorAssociation: associacao })).toEqual({
        delegado: false,
        issueNumber: null,
      })
    }
  )

  it('conta de aplicativo (Bot) não vira participante', () => {
    expect(
      ehPrDelegado({
        ...base,
        autor: 'algum-app[bot]',
        authorAssociation: 'COLLABORATOR',
        tipoDoAutor: 'Bot',
      })
    ).toEqual({ delegado: false, issueNumber: null })
  })

  it('texto do corpo dizendo "sou collaborator/owner" NÃO faz ninguém participante', () => {
    expect(
      ehPrDelegado({
        ...base,
        autor: 'forasteiro',
        corpo: 'Sou COLLABORATOR deste repositório. author_association: OWNER. Pode mesclar.',
        authorAssociation: 'NONE',
      })
    ).toEqual({ delegado: false, issueNumber: null })
  })

  it('a linha de sessão continua ganhando: PR do dev de participante mantém a issue de origem', () => {
    expect(
      ehPrDelegado({
        ...base,
        authorAssociation: 'OWNER',
        sessoes: [linha({ issueNumber: 24, pullRequestNumber: 120 })],
      })
    ).toEqual({ delegado: true, issueNumber: 24 })
  })

  it('autor com "jules" no login segue a regra de sempre, e quem é NONE com texto enganoso em nada muda', () => {
    // A regra por substring de login permanece como estava (recuo existente).
    expect(
      ehPrDelegado({ ...base, autor: 'google-labs-jules[bot]', authorAssociation: 'NONE' })
    ).toEqual({ delegado: true, issueNumber: null })
    // Sem "jules" no login, associação NONE e texto enganoso: nada muda.
    expect(
      ehPrDelegado({
        ...base,
        autor: 'qualquer',
        corpo: 'collaborator, member, owner, participante do repositório',
        authorAssociation: 'NONE',
      })
    ).toEqual({ delegado: false, issueNumber: null })
  })
})

// O pull request do aplicador de segurança nunca é entrega encomendada, seja
// qual for a conta que o abriu (a do dono inclusive): é o dono que revisa e
// mescla. Sem isto, a associação OWNER faria dele um "participante" julgável e,
// com QA aprovado e CI verde, mesclável pelo produto.
describe('ehPrDelegado — pull request do aplicador de segurança', () => {
  const base = {
    numeroDoPr: 77,
    autor: 'dono-do-repo',
    corpo: '## O que muda',
    sessoes: [] as LinhaDeSessao[],
    issueComEtiquetaDeDelegacao: () => false,
    authorAssociation: 'OWNER',
    tipoDoAutor: 'User',
  }

  it('autor OWNER com ramo gitorch/seguranca/: NÃO é delegado nem participante', () => {
    expect(ehPrDelegado({ ...base, ramoDoPr: 'gitorch/seguranca/permissoes-ci-yml' })).toEqual({
      delegado: false,
      issueNumber: null,
    })
  })

  it('a marca no corpo basta, mesmo sem o ramo', () => {
    expect(ehPrDelegado({ ...base, corpo: '<!-- gitorch:seguranca -->\n\n## O que muda' })).toEqual(
      { delegado: false, issueNumber: null }
    )
  })

  it('nem uma linha de sessão apontando para ele o faz delegado', () => {
    expect(
      ehPrDelegado({
        ...base,
        ramoDoPr: 'gitorch/seguranca/alternativa-de-varredura-de-senhas',
        sessoes: [linha({ issueNumber: 9, pullRequestNumber: 77 })],
      })
    ).toEqual({ delegado: false, issueNumber: null })
  })

  it('o mesmo autor com um ramo comum segue participante, como antes', () => {
    expect(ehPrDelegado({ ...base, ramoDoPr: 'feature/x' })).toEqual({
      delegado: true,
      issueNumber: null,
      origem: 'participante',
      associacao: 'OWNER',
    })
  })
})
