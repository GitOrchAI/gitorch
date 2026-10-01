import { describe, it, expect } from 'vitest'
import { decidirProximoPasso, type MotorDoProximoPassoDeps } from './motor-do-proximo-passo.js'
import { PADRAO_DE_CUIDADO } from './cuidado-por-origem.js'

function base(): MotorDoProximoPassoDeps {
  return {
    numero: 42,
    sinais: { autor: 'jules', labels: ['jules'], corpo: null },
    temSessaoViva: false,
    issueNumber: 10,
    issueAberta: true,
    mergeable: false, // causa = conflito para testar retomada
    verificacao: 'verde',
    paradoHaMs: 4 * 24 * 60 * 60 * 1000,
    acoesAnteriores: 0,
    tarefaJaDevolvidaAFila: false,
    podeAbrirSessao: true,
    origem: 'jules',
    cuidaPorOrigem: PADRAO_DE_CUIDADO,
    emConstrucaoHa: null, // fora da janela
    janelaEmConstrucaoHoras: 2,
    branchDoPr: 'ramo',
    branchNoRepoDoProjeto: true,
  }
}

describe('decidirProximoPasso — portões herdados de decidirAcaoNoPrOrfao', () => {
  it('PR de gente: ignora (mesmo portão 1 de hoje)', () => {
    const d = decidirProximoPasso({
      ...base(),
      sinais: { autor: 'loureng', labels: [], corpo: null },
    })
    expect(d.acao).toBe('so-acompanhar')
  })

  it('sessão viva: ignora (mesmo portão 3 de hoje)', () => {
    const d = decidirProximoPasso({ ...base(), temSessaoViva: true })
    expect(d.acao).toBe('so-acompanhar')
  })

  it('conflito, sem sessão viva, fora da janela de construção: retoma', () => {
    const d = decidirProximoPasso(base())
    expect(d.acao).toBe('retomar')
  })

  it('parado há 4h com parecer do QA pedindo mudanças: retoma (não espera 3 dias)', () => {
    const d = decidirProximoPasso({
      ...base(),
      mergeable: true,
      verificacao: 'verde',
      paradoHaMs: 4 * 60 * 60 * 1000,
      ultimoParecerQa: { body: 'Rode o Prettier.', timestamp: new Date('2026-09-30T10:00:00Z') },
    })
    expect(d.acao).toBe('retomar')
    if (d.acao !== 'retomar') throw new Error('esperava retomar')
    expect(d.causa).toBe('qa-reprovou')
  })

  it('parado há 2h: só acompanha, mesmo com parecer pedindo mudanças', () => {
    const d = decidirProximoPasso({
      ...base(),
      mergeable: true,
      verificacao: 'vermelha',
      paradoHaMs: 2 * 60 * 60 * 1000,
      ultimoParecerQa: { body: 'Rode o Prettier.', timestamp: new Date('2026-09-30T10:00:00Z') },
    })
    expect(d.acao).toBe('so-acompanhar')
  })

  it('sessão viva aos 4h continua sem ser tocada', () => {
    const d = decidirProximoPasso({
      ...base(),
      temSessaoViva: true,
      paradoHaMs: 4 * 60 * 60 * 1000,
      verificacao: 'vermelha',
    })
    expect(d.acao).toBe('so-acompanhar')
  })

  it('tarefa já fechada: fecha o PR como vazio, com o motivo', () => {
    const d = decidirProximoPasso({ ...base(), issueAberta: false })
    expect(d).toEqual({
      acao: 'fechar-vazio',
      motivo: 'a tarefa #10 já está fechada',
    })
  })
})

describe('decidirProximoPasso — o que muda: nunca "alguém precisa olhar" sem checar a configuração', () => {
  it('nada para consertar + cuidaPorOrigem="sim": mescla (quando os 3 critérios da Tarefa 3.8 batem)', () => {
    const d = decidirProximoPasso({
      ...base(),
      mergeable: true,
      verificacao: 'verde',
      entendimentoCompleto: true,
      vereditoDoQa: 'approve',
    })
    expect(d.acao).toBe('mesclar')
  })

  it('nada para consertar + cuidaPorOrigem="sim" MAS exigeRevisaoDeSeguranca: degrada para perguntar-se-cuida', () => {
    const d = decidirProximoPasso({
      ...base(),
      mergeable: true,
      verificacao: 'verde',
      entendimentoCompleto: true,
      vereditoDoQa: 'approve',
      exigeRevisaoDeSeguranca: true,
    })
    expect(d.acao).toBe('perguntar-se-cuida')
    expect(d.motivo).toContain('exige revisão humana de segurança')
  })

  it('nada para consertar + cuidaPorOrigem="perguntar": pergunta se cuida, nunca escala direto', () => {
    const d = decidirProximoPasso({
      ...base(),
      mergeable: true,
      verificacao: 'verde',
      cuidaPorOrigem: { ...PADRAO_DE_CUIDADO, jules: 'perguntar' },
    })
    expect(d.acao).toBe('perguntar-se-cuida')
  })

  it('cuidaPorOrigem="nao": só acompanha, nunca julga', () => {
    const d = decidirProximoPasso({
      ...base(),
      cuidaPorOrigem: { ...PADRAO_DE_CUIDADO, jules: 'nao' },
    })
    expect(d.acao).toBe('so-acompanhar')
  })

  it('em construção (dentro da janela): só acompanha, mesmo com cuidaPorOrigem="sim"', () => {
    const d = decidirProximoPasso({ ...base(), emConstrucaoHa: 1 })
    expect(d.acao).toBe('so-acompanhar')
  })

  it('em construção mas JÁ passou da janela: volta a valer o resto da decisão', () => {
    const d = decidirProximoPasso({ ...base(), emConstrucaoHa: 5 })
    expect(d.acao).toBe('retomar')
  })

  it('dado desconhecido: degrada para acompanhar sem mesclar/fechar/rebasear às cegas', () => {
    // se por um acaso mergeable for nulo (API em recalculo) mesmo depois de pronto
    const d = decidirProximoPasso({ ...base(), mergeable: null })
    expect(d.acao).toBe('so-acompanhar')
  })
})

describe('motor-do-proximo-passo (escalar)', () => {
  it('motor nunca devolve escalar como acao padrao', () => {
    const d = decidirProximoPasso({
      ...base(),
      origem: 'desconhecido',
      cuidaPorOrigem: { ...PADRAO_DE_CUIDADO },
    })
    expect(d.acao).not.toBe('escalar')
  })
})

// O QA atende o PR de participante do repositório (OWNER/MEMBER/COLLABORATOR),
// mas o motor do vigia continua só acompanhando — retomar, fechar, devolver à
// fila, escalar ou mesclar é coisa da automação.
describe('decidirProximoPasso — PR de participante do repositório', () => {
  const PARTICIPANTE = {
    autor: 'colega-da-equipe',
    labels: [] as string[],
    corpo: 'Ajuste do colega',
  }
  const configs = [
    { jules: 'sim', assistente: 'sim', pessoa: 'sim', dependabot: 'sim' },
    { jules: 'perguntar', assistente: 'perguntar', pessoa: 'perguntar', dependabot: 'perguntar' },
    PADRAO_DE_CUIDADO,
  ] as const

  it('só acompanha, em qualquer origem, configuração ou estado (parado 16 dias, com parecer)', () => {
    const acoes = new Set<string>()
    for (const cuidaPorOrigem of configs) {
      for (const origem of ['pessoa', 'jules', 'jules_gitorch', 'desconhecido', 'assistente']) {
        for (const mergeable of [true, false, null]) {
          for (const verificacao of ['verde', 'vermelha', 'pendente'] as const) {
            for (const issueNumber of [10, null]) {
              for (const acoesAnteriores of [0, 5]) {
                acoes.add(
                  decidirProximoPasso({
                    ...base(),
                    sinais: PARTICIPANTE,
                    cuidaPorOrigem,
                    origem,
                    mergeable,
                    verificacao,
                    issueNumber,
                    acoesAnteriores,
                    paradoHaMs: 16 * 24 * 60 * 60 * 1000,
                    vereditoDoQa: 'approve',
                    entendimentoCompleto: true,
                    ultimoParecerQa: {
                      body: 'Pedir mudanças: falta teste.',
                      timestamp: new Date('2026-09-15T10:00:00Z'),
                    },
                  }).acao
                )
              }
            }
          }
        }
      }
    }
    expect([...acoes]).toEqual(['so-acompanhar'])
  })
})
