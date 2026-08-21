import { describe, expect, it } from 'vitest'
import { casarPrComSessao } from './casar-pr-com-sessao.js'

/**
 * O caso REAL que motivou este casador (medido em produção 20/08/2026):
 * PR #132, branch `jules-12112302527133030906-e9d57552`, sessão
 * `sessions/12112302527133030906`. A ligação levou 6h30 para ser gravada
 * porque dependia do dev externo reportar; o branch já trazia o identificador
 * no segundo zero.
 */
const SESSAO_DO_132 = { sessionName: 'sessions/12112302527133030906', pullRequestNumber: null }
const SESSAO_DO_133 = { sessionName: 'sessions/2393879608896482841', pullRequestNumber: null }

describe('casarPrComSessao', () => {
  // Os CINCO nomes de branch reais que o dev assíncrono produziu neste
  // repositório (lidos da API do GitHub em 21/08/2026). Ele usa DOIS padrões,
  // e o segundo é o mais comum — o identificador vai no FIM, sem prefixo:
  //   #132  jules-12112302527133030906-e9d57552
  //   #133  fix-dependabot-pnpm-config-2393879608896482841
  //   #97   fix/jules-pr-ci-failure-fallback-2772598213435248562
  //   #79   fix/ci-failure-fallback-token-18033236850476632477
  //   #75   fix-jules-apology-handler-token-6237721600950278679
  it.each([
    ['jules-12112302527133030906-e9d57552', '12112302527133030906'],
    ['fix-dependabot-pnpm-config-2393879608896482841', '2393879608896482841'],
    ['fix/jules-pr-ci-failure-fallback-2772598213435248562', '2772598213435248562'],
    ['fix/ci-failure-fallback-token-18033236850476632477', '18033236850476632477'],
    ['fix-jules-apology-handler-token-6237721600950278679', '6237721600950278679'],
  ])('reconhece o branch real %s', (branch, id) => {
    const r = casarPrComSessao({
      headRefName: branch,
      corpo: '',
      sessoes: [{ sessionName: `sessions/${id}`, pullRequestNumber: null }],
    })
    expect(r).toEqual({ sessionName: `sessions/${id}` })
  })

  it('número curto no fim do branch não é identificador de sessão', () => {
    // `fix/issue-123` é nome de branch de gente. Os identificadores do dev têm
    // dezenove ou vinte dígitos; exigir comprimento evita sequer procurar.
    expect(
      casarPrComSessao({
        headRefName: 'fix/issue-123',
        corpo: '',
        sessoes: [{ sessionName: 'sessions/123', pullRequestNumber: null }],
      })
    ).toBeNull()
  })

  it('casa pelo branch do dev assíncrono — o sinal que chega primeiro', () => {
    const r = casarPrComSessao({
      headRefName: 'jules-12112302527133030906-e9d57552',
      corpo: 'Fix Dependabot schema validation by using native pnpm support.',
      sessoes: [SESSAO_DO_133, SESSAO_DO_132],
    })
    expect(r).toEqual({ sessionName: 'sessions/12112302527133030906' })
  })

  it('cai para o corpo do PR quando o branch não carrega o identificador', () => {
    const r = casarPrComSessao({
      headRefName: 'fix/dependabot-pnpm',
      corpo:
        '---\n*PR created automatically by Jules for task ' +
        '[12112302527133030906](https://jules.google.com/task/12112302527133030906) started by @loureng*',
      sessoes: [SESSAO_DO_132],
    })
    expect(r).toEqual({ sessionName: 'sessions/12112302527133030906' })
  })

  it('sem nenhum identificador, não casa — PR de humano não é entrega delegada', () => {
    expect(
      casarPrComSessao({
        headRefName: 'fix/ajuste-manual',
        corpo: 'Corrige o rodapé da home. Fixes #74',
        sessoes: [SESSAO_DO_132, SESSAO_DO_133],
      })
    ).toBeNull()
  })

  it('identificador sem sessão correspondente não casa com a sessão vizinha', () => {
    expect(
      casarPrComSessao({
        headRefName: 'jules-99999999999999999-abc123',
        corpo: '',
        sessoes: [SESSAO_DO_132, SESSAO_DO_133],
      })
    ).toBeNull()
  })

  it('com uma única sessão aberta, ainda assim exige o identificador — nunca adivinha', () => {
    expect(
      casarPrComSessao({
        headRefName: 'main',
        corpo: 'sem marcador nenhum',
        sessoes: [SESSAO_DO_132],
      })
    ).toBeNull()
  })

  it('casa por segmento inteiro: um nome que só CONTÉM o identificador não serve', () => {
    // `sessions/121123025271330309061` termina com um número que tem o
    // identificador como prefixo. Comparar por "contém" ou por "termina com o
    // texto" casaria errado e ligaria o PR à entrega de outra tarefa.
    expect(
      casarPrComSessao({
        headRefName: 'jules-12112302527133030906-e9d57552',
        corpo: '',
        sessoes: [{ sessionName: 'sessions/121123025271330309061', pullRequestNumber: null }],
      })
    ).toBeNull()
  })

  it('aceita o nome de sessão sem prefixo de caminho', () => {
    const r = casarPrComSessao({
      headRefName: 'jules-2393879608896482841-ff01',
      corpo: '',
      sessoes: [{ sessionName: '2393879608896482841', pullRequestNumber: null }],
    })
    expect(r).toEqual({ sessionName: '2393879608896482841' })
  })

  it('não devolve casamento quando a sessão já aponta para ESTE mesmo PR', () => {
    // Idempotência na origem: reabrir um PR dispara o aviso de novo, e regravar
    // o mesmo número só gastaria escrita no banco e mexeria em `stateCheckedAt`,
    // que é a régua da cadência da vigia.
    expect(
      casarPrComSessao({
        headRefName: 'jules-12112302527133030906-e9d57552',
        corpo: '',
        numeroDoPr: 132,
        sessoes: [{ sessionName: 'sessions/12112302527133030906', pullRequestNumber: 132 }],
      })
    ).toBeNull()
  })

  it('regrava quando a sessão aponta para OUTRO PR — o dev abriu entrega nova', () => {
    const r = casarPrComSessao({
      headRefName: 'jules-12112302527133030906-e9d57552',
      corpo: '',
      numeroDoPr: 140,
      sessoes: [{ sessionName: 'sessions/12112302527133030906', pullRequestNumber: 132 }],
    })
    expect(r).toEqual({ sessionName: 'sessions/12112302527133030906' })
  })

  it('lista de sessões vazia não quebra', () => {
    expect(casarPrComSessao({ headRefName: 'jules-1-a', corpo: '', sessoes: [] })).toBeNull()
  })
})
