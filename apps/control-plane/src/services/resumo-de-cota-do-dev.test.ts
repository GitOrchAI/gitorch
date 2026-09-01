import { describe, expect, test } from 'vitest'
import {
  resumoDeCotaDoDev,
  type ProjetoParaResumo,
  type SessaoParaResumo,
} from './resumo-de-cota-do-dev.js'

// Pedido do dono (01/09/2026): "precisa saber o que está sendo enviado, quando
// foi enviado" — ver o consumo do Jules, não adivinhar. Este módulo é a
// função PURA que monta esse resumo (contagem por CONTA — o teto é da conta,
// não do projeto, mesmo motivo de montarOpcoesDeDelegacao em scheduler.ts);
// a rota em routes/painel.ts só busca as linhas e chama isto.

const AGORA = new Date('2026-09-01T15:00:00.000Z')
const H24_ATRAS = new Date(AGORA.getTime() - 24 * 60 * 60 * 1000)

function projeto(over: Partial<ProjetoParaResumo> = {}): ProjetoParaResumo {
  return {
    id: 'proj-1',
    nome: 'GitOrchAI/gitorch',
    devPlan: 'pro',
    devAccountId: null,
    ...over,
  }
}

function sessao(over: Partial<SessaoParaResumo> = {}): SessaoParaResumo {
  return {
    projectId: 'proj-1',
    devAccountId: null,
    issueNumber: 1,
    sessionName: 'sessions/1',
    state: 'IN_PROGRESS',
    createdAt: AGORA,
    closedAt: null,
    ...over,
  }
}

describe('resumoDeCotaDoDev', () => {
  test('sem projeto nenhum, devolve lista de contas vazia', () => {
    const resumo = resumoDeCotaDoDev({ projetos: [], sessoes: [], agora: AGORA })
    expect(resumo.contas).toEqual([])
    expect(resumo.agora).toBe(AGORA.toISOString())
  })

  test('teto vem do plano do projeto — pro é 15 simultâneas e 100 por dia (jules.google/docs/usage-limits)', () => {
    const resumo = resumoDeCotaDoDev({
      projetos: [projeto({ devPlan: 'pro' })],
      sessoes: [],
      agora: AGORA,
    })
    expect(resumo.contas[0]?.tetoConcorrentes).toBe(15)
    expect(resumo.contas[0]?.tetoDiario).toBe(100)
  })

  test('conta sem devAccountId (BYOK ausente) é a conta padrão da instância — null, não uma string inventada', () => {
    const resumo = resumoDeCotaDoDev({
      projetos: [projeto({ devAccountId: null })],
      sessoes: [],
      agora: AGORA,
    })
    expect(resumo.contas[0]?.contaId).toBeNull()
  })

  test('dois projetos que dividem a MESMA conta viram UMA linha — o teto é da conta, não do projeto', () => {
    // Achado de 29/08 (sm-delegation.ts): contar por projeto fez dois
    // projetos "pro" se acharem com 200/dia e 30 simultâneas contra um teto
    // real de 100 e 15. A visibilidade não pode repetir o erro que o cálculo
    // real já corrigiu.
    const resumo = resumoDeCotaDoDev({
      projetos: [
        projeto({ id: 'a', nome: 'GitOrchAI/gitorch', devAccountId: null }),
        projeto({ id: 'b', nome: 'loureng/patinhas-3d-crafts', devAccountId: null }),
      ],
      sessoes: [],
      agora: AGORA,
    })
    expect(resumo.contas).toHaveLength(1)
    expect(resumo.contas[0]?.projetos.sort()).toEqual([
      'GitOrchAI/gitorch',
      'loureng/patinhas-3d-crafts',
    ])
  })

  test('conta com planos divergentes entre projetos exibe o MAIS RESTRITIVO — errar pra baixo é seguro', () => {
    const resumo = resumoDeCotaDoDev({
      projetos: [
        projeto({ id: 'a', devPlan: 'pro', devAccountId: 'conta-x' }),
        projeto({ id: 'b', devPlan: 'free', devAccountId: 'conta-x' }),
      ],
      sessoes: [],
      agora: AGORA,
    })
    expect(resumo.contas[0]?.tetoConcorrentes).toBe(3)
    expect(resumo.contas[0]?.tetoDiario).toBe(15)
    expect(resumo.contas[0]?.plano).toBe('free')
  })

  test('simultâneas conta só quem OCUPA VAGA agora — COMPLETED/FAILED/CANCELLED não contam mesmo com closedAt nulo', () => {
    // Mesmo achado de 29/08 que motivou estados-de-sessao.ts: a linha pode
    // ficar com closed_at nulo por um instante depois de terminar no
    // fornecedor. O produto real filtra por `state`, não só por `closedAt`.
    const resumo = resumoDeCotaDoDev({
      projetos: [projeto()],
      sessoes: [
        sessao({ sessionName: 's1', state: 'IN_PROGRESS', closedAt: null }),
        sessao({ sessionName: 's2', state: 'COMPLETED', closedAt: null }),
        sessao({ sessionName: 's3', state: 'QUEUED', closedAt: null }),
        sessao({ sessionName: 's4', state: 'IN_PROGRESS', closedAt: AGORA }),
      ],
      agora: AGORA,
    })
    expect(resumo.contas[0]?.simultaneas).toBe(2)
    expect(resumo.contas[0]?.vagasRestantes).toBe(13)
  })

  test('vagasRestantes nunca fica negativo mesmo se a conta estourou o teto', () => {
    const muitas = Array.from({ length: 20 }, (_, i) =>
      sessao({ sessionName: `s${i}`, state: 'IN_PROGRESS', closedAt: null })
    )
    const resumo = resumoDeCotaDoDev({
      projetos: [projeto({ devPlan: 'pro' })],
      sessoes: muitas,
      agora: AGORA,
    })
    expect(resumo.contas[0]?.simultaneas).toBe(20)
    expect(resumo.contas[0]?.vagasRestantes).toBe(0)
  })

  test('enviadas24h é JANELA ROLANTE — sessão de ontem na mesma hora ainda conta, de anteontem não', () => {
    const resumo = resumoDeCotaDoDev({
      projetos: [projeto()],
      sessoes: [
        sessao({
          sessionName: 'dentro-da-janela',
          createdAt: new Date(H24_ATRAS.getTime() + 1000),
        }),
        sessao({ sessionName: 'fora-da-janela', createdAt: new Date(H24_ATRAS.getTime() - 1000) }),
      ],
      agora: AGORA,
    })
    expect(resumo.contas[0]?.enviadas24h).toBe(1)
    expect(resumo.contas[0]?.vagasDiariasRestantes).toBe(99)
  })

  test('sessoes24h lista quando cada uma saiu, mais recente primeiro, só as recentes', () => {
    const antiga = new Date(H24_ATRAS.getTime() - 60_000)
    const recente = new Date(AGORA.getTime() - 60_000)
    const maisRecente = new Date(AGORA.getTime() - 1_000)
    const resumo = resumoDeCotaDoDev({
      projetos: [projeto()],
      sessoes: [
        sessao({ sessionName: 'antiga', issueNumber: 1, createdAt: antiga }),
        sessao({ sessionName: 'recente', issueNumber: 2, createdAt: recente }),
        sessao({ sessionName: 'mais-recente', issueNumber: 3, createdAt: maisRecente }),
      ],
      agora: AGORA,
    })
    expect(resumo.contas[0]?.sessoes24h.map((s) => s.sessionName)).toEqual([
      'mais-recente',
      'recente',
    ])
    expect(resumo.contas[0]?.sessoes24h[0]).toMatchObject({
      sessionName: 'mais-recente',
      issueNumber: 3,
      projeto: 'GitOrchAI/gitorch',
      estado: 'IN_PROGRESS',
      enviadaEm: maisRecente.toISOString(),
      ocupaVaga: true,
    })
  })

  test('sessão terminal aparece na lista das 24h marcada como sem vaga ocupada — histórico, não estado atual', () => {
    const resumo = resumoDeCotaDoDev({
      projetos: [projeto()],
      sessoes: [sessao({ sessionName: 'acabou', state: 'COMPLETED', closedAt: AGORA })],
      agora: AGORA,
    })
    expect(resumo.contas[0]?.sessoes24h[0]).toMatchObject({
      sessionName: 'acabou',
      estado: 'COMPLETED',
      ocupaVaga: false,
    })
  })
})
