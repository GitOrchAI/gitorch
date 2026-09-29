import { describe, it, expect } from 'vitest'
import type { Prisma } from '@prisma/client'
import {
  CORTE_DAS_RETOMADAS_COM_DEFEITO,
  MAX_ACOES_DO_VIGIA,
  contarAcoesDoVigia,
  decidirAcaoNoPrOrfao,
  montarPedidoDeConsertoDoVigia,
  tarefaJaFoiDevolvidaAFila,
  vigiarPrsOrfaos,
  type ContadorDeEventos,
  type PrAberto,
  type PrOrfaoObservado,
  type VigiaDoPrDeps,
} from './vigia-do-pr.js'
import { decidirProximoPasso } from './motor-do-proximo-passo.js'
import { PADRAO_DE_CUIDADO } from './cuidado-por-origem.js'
import { AUTOR_PR_356, CORPO_PR_356_DEV, LABELS_PR_356 } from './__fixtures__/corpos-reais-de-pr.js'

const DIA = 24 * 60 * 60 * 1000

// ————— banco em memória: interpreta só os filtros que o vigia usa —————

interface EventoGravado {
  projectId: string
  type: string
  createdAt: Date
  payload: { vigiaDoPr: { numeroDoPr: number; acao: string; issueNumber?: number } }
}

function caminhoDoPayload(e: EventoGravado, caminho: string[]): unknown {
  let atual: unknown = e.payload
  for (const chave of caminho) {
    if (atual === null || typeof atual !== 'object') return undefined
    atual = (atual as Record<string, unknown>)[chave]
  }
  return atual
}

function bateComFiltro(e: EventoGravado, where: Prisma.EventWhereInput): boolean {
  if (where.projectId !== undefined && where.projectId !== e.projectId) return false
  if (where.type !== undefined && where.type !== e.type) return false
  const criadoEm = where.createdAt as { gte?: Date } | undefined
  if (criadoEm?.gte && e.createdAt < criadoEm.gte) return false
  const payload = where.payload as { path: string[]; equals: unknown } | undefined
  if (payload && caminhoDoPayload(e, payload.path) !== payload.equals) return false
  const and = where.AND as Prisma.EventWhereInput[] | undefined
  if (and && !and.every((f) => bateComFiltro(e, f))) return false
  return true
}

function bancoComEventos(eventos: EventoGravado[]): ContadorDeEventos {
  return {
    event: {
      count: async ({ where }) => eventos.filter((e) => bateComFiltro(e, where)).length,
    },
  }
}

function acaoGravada(
  numeroDoPr: number,
  createdAt: string,
  acao = 'retomar',
  issueNumber?: number
): EventoGravado {
  return {
    projectId: 'p1',
    type: 'audit',
    createdAt: new Date(createdAt),
    payload: {
      vigiaDoPr: { numeroDoPr, acao, ...(issueNumber !== undefined ? { issueNumber } : {}) },
    },
  }
}

describe('corte da contagem: retomadas do período com defeito não contam', () => {
  it('a data de corte é 30/09/2026 00:00 UTC', () => {
    expect(CORTE_DAS_RETOMADAS_COM_DEFEITO.toISOString()).toBe('2026-09-30T00:00:00.000Z')
  })

  it('PR com 2 retomadas e 1 escalada ANTES do corte conta zero', async () => {
    const banco = bancoComEventos([
      acaoGravada(3995, '2026-09-20T10:00:00Z'),
      acaoGravada(3995, '2026-09-22T10:00:00Z'),
      acaoGravada(3995, '2026-09-24T10:00:00Z', 'escalar'),
    ])
    expect(await contarAcoesDoVigia(banco, { projectId: 'p1', numeroDoPr: 3995 })).toBe(0)
  })

  it('só as ações a partir do corte entram, e só as do PR pedido', async () => {
    const banco = bancoComEventos([
      acaoGravada(3995, '2026-09-29T23:59:59Z'),
      acaoGravada(3995, '2026-09-30T00:00:00Z'),
      acaoGravada(3995, '2026-10-02T10:00:00Z'),
      acaoGravada(4001, '2026-10-02T10:00:00Z'),
    ])
    expect(await contarAcoesDoVigia(banco, { projectId: 'p1', numeroDoPr: 3995 })).toBe(2)
  })

  it('`depoisDe` posterior ao corte restringe mais; anterior ao corte é ignorado', async () => {
    const banco = bancoComEventos([
      acaoGravada(3995, '2026-10-01T10:00:00Z'),
      acaoGravada(3995, '2026-10-05T10:00:00Z'),
    ])
    expect(
      await contarAcoesDoVigia(banco, {
        projectId: 'p1',
        numeroDoPr: 3995,
        depoisDe: new Date('2026-10-03T00:00:00Z'),
      })
    ).toBe(1)
    expect(
      await contarAcoesDoVigia(banco, {
        projectId: 'p1',
        numeroDoPr: 3995,
        depoisDe: new Date('2026-01-01T00:00:00Z'),
      })
    ).toBe(2)
  })

  it('PR escalado e abandonado antes do corte volta a ser retomado pela varredura', async () => {
    const banco = bancoComEventos([
      acaoGravada(3995, '2026-09-20T10:00:00Z'),
      acaoGravada(3995, '2026-09-22T10:00:00Z'),
      acaoGravada(3995, '2026-09-24T10:00:00Z', 'escalar'),
    ])
    const retomados: number[] = []
    const resumo = await rodar({
      prs: [prAberto(3995)],
      issueDoPr: () => 3987,
      acoesAnteriores: (n) => contarAcoesDoVigia(banco, { projectId: 'p1', numeroDoPr: n }),
      abrirSessaoDeConserto: async ({ numeroDoPr }) => {
        retomados.push(numeroDoPr)
        return true
      },
    })
    expect(retomados).toEqual([3995])
    expect(resumo).toContain('1 retomado')
  })
})

describe('devolução da tarefa à fila depois do limite', () => {
  function situacao(over: Partial<PrOrfaoObservado> = {}): PrOrfaoObservado {
    return {
      numero: 3995,
      sinais: { autor: AUTOR_PR_356, labels: LABELS_PR_356, corpo: CORPO_PR_356_DEV },
      temSessaoViva: false,
      issueNumber: 3987,
      rascunho: false,
      issueAberta: true,
      branchDoPr: 'jules-123-abc',
      branchNoRepoDoProjeto: true,
      mergeable: false,
      verificacao: 'verde',
      paradoHaMs: 7 * DIA,
      acoesAnteriores: MAX_ACOES_DO_VIGIA,
      tarefaJaDevolvidaAFila: false,
      podeAbrirSessao: true,
      ...over,
    }
  }

  it('no limite, a primeira vez decide devolver à fila em vez de escalar', () => {
    const d = decidirAcaoNoPrOrfao(situacao())
    expect(d).toMatchObject({ acao: 'devolver-a-fila', issueNumber: 3987 })
  })

  it('o texto da devolução é de negócio: sem jargão nem ID de sessão', () => {
    const d = decidirAcaoNoPrOrfao(situacao())
    expect(d.motivo).toContain('#3995')
    expect(d.motivo).not.toMatch(/sessions\/|workingBranch|startingBranch|rebase|CI\b/i)
  })

  it('tarefa que JÁ foi devolvida antes: escala ao dono (uma vez por tarefa)', () => {
    const d = decidirAcaoNoPrOrfao(situacao({ tarefaJaDevolvidaAFila: true }))
    expect(d.acao).toBe('escalar')
  })

  it('depois da escalada (acoes > limite) o vigia se cala', () => {
    const d = decidirAcaoNoPrOrfao(situacao({ acoesAnteriores: MAX_ACOES_DO_VIGIA + 1 }))
    expect(d.acao).toBe('ignorar')
  })

  it('abaixo do limite continua retomando', () => {
    const d = decidirAcaoNoPrOrfao(situacao({ acoesAnteriores: MAX_ACOES_DO_VIGIA - 1 }))
    expect(d.acao).toBe('retomar')
  })

  it('tarefa já fechada não é devolvida à fila (o portão de tarefa fechada fecha o PR)', () => {
    const d = decidirAcaoNoPrOrfao(situacao({ issueAberta: false }))
    expect(d.acao).not.toBe('devolver-a-fila')
  })

  it('o motor de produção decide igual: no limite, devolve à fila uma vez', () => {
    const base = {
      numero: 3995,
      sinais: { autor: 'jules', labels: ['jules'], corpo: null },
      temSessaoViva: false,
      issueNumber: 3987,
      issueAberta: true,
      mergeable: false,
      verificacao: 'verde' as const,
      paradoHaMs: 4 * DIA,
      acoesAnteriores: MAX_ACOES_DO_VIGIA,
      tarefaJaDevolvidaAFila: false,
      podeAbrirSessao: true,
      origem: 'jules',
      cuidaPorOrigem: PADRAO_DE_CUIDADO,
      emConstrucaoHa: null,
      janelaEmConstrucaoHoras: 2,
      branchDoPr: 'ramo',
      branchNoRepoDoProjeto: true,
    }
    expect(decidirProximoPasso(base)).toMatchObject({
      acao: 'devolver-a-fila',
      issueNumber: 3987,
    })
    // Já devolvida antes: cai no caminho de sempre (não repete o ciclo).
    expect(decidirProximoPasso({ ...base, tarefaJaDevolvidaAFila: true }).acao).toBe('retomar')
  })

  it('a marca de "já devolvida" é por TAREFA, lida dos eventos', async () => {
    const banco = bancoComEventos([
      acaoGravada(3995, '2026-10-05T10:00:00Z', 'devolver-a-fila', 3987),
    ])
    expect(await tarefaJaFoiDevolvidaAFila(banco, { projectId: 'p1', issueNumber: 3987 })).toBe(
      true
    )
    expect(await tarefaJaFoiDevolvidaAFila(banco, { projectId: 'p1', issueNumber: 4000 })).toBe(
      false
    )
    // Retomar/escalar comum não é devolução.
    const outro = bancoComEventos([acaoGravada(3995, '2026-10-05T10:00:00Z', 'escalar', 3987)])
    expect(await tarefaJaFoiDevolvidaAFila(outro, { projectId: 'p1', issueNumber: 3987 })).toBe(
      false
    )
  })

  it('a varredura fecha o PR antigo com o motivo, grava a devolução e NÃO avisa o dono', async () => {
    const fechados: Array<{ numero: number; motivo: string }> = []
    const eventos: Array<{ numeroDoPr: number; acao: string; issueNumber?: number }> = []
    const avisos: string[] = []
    const resumo = await rodar({
      prs: [prAberto(3995)],
      issueDoPr: () => 3987,
      acoesAnteriores: async () => MAX_ACOES_DO_VIGIA,
      fecharPr: async (a) => {
        fechados.push(a)
        return true
      },
      registrarDecisao: async (e) => {
        eventos.push(e)
      },
      avisarDono: async (t) => {
        avisos.push(t)
        return true
      },
    })
    expect(fechados).toHaveLength(1)
    expect(fechados[0]!.numero).toBe(3995)
    expect(fechados[0]!.motivo).toContain('devolver a tarefa para a fila')
    expect(eventos).toEqual([
      expect.objectContaining({ numeroDoPr: 3995, acao: 'devolver-a-fila', issueNumber: 3987 }),
    ])
    expect(avisos).toEqual([])
    expect(resumo).toContain('1 devolvido à fila')
  })

  it('se não conseguir fechar o PR, escala ao dono (e não grava devolução)', async () => {
    const eventos: Array<{ acao: string }> = []
    const avisos: string[] = []
    await rodar({
      prs: [prAberto(3995)],
      issueDoPr: () => 3987,
      acoesAnteriores: async () => MAX_ACOES_DO_VIGIA,
      fecharPr: async () => false,
      registrarDecisao: async (e) => {
        eventos.push(e)
      },
      avisarDono: async (t) => {
        avisos.push(t)
        return true
      },
    })
    expect(eventos.map((e) => e.acao)).toEqual(['escalar'])
    expect(avisos).toHaveLength(1)
    expect(avisos[0]).toContain('#3995')
    expect(avisos[0]).not.toMatch(/sessions\//)
  })

  it('tarefa já devolvida uma vez: a varredura escala em vez de fechar de novo', async () => {
    const fechados: number[] = []
    const eventos: Array<{ acao: string }> = []
    await rodar({
      prs: [prAberto(4010)],
      issueDoPr: () => 3987,
      acoesAnteriores: async () => MAX_ACOES_DO_VIGIA,
      tarefaJaDevolvidaAFila: async () => true,
      fecharPr: async (a) => {
        fechados.push(a.numero)
        return true
      },
      registrarDecisao: async (e) => {
        eventos.push(e)
      },
    })
    expect(fechados).toEqual([])
    expect(eventos.map((e) => e.acao)).toEqual(['escalar'])
  })
})

describe('pedido da sessão de conserto do vigia', () => {
  it('mantém o pedido original e manda partir do ramo e publicar PR novo contra a main', () => {
    const pedido = montarPedidoDeConsertoDoVigia({
      numeroDoPr: 3995,
      ramoDoPr: 'jules-123-abc',
      pedido: 'Resolva o conflito.',
    })
    expect(pedido.startsWith('Resolva o conflito.')).toBe(true)
    expect(pedido).toContain('`jules-123-abc`')
    expect(pedido).toContain('#3995')
    expect(pedido).toMatch(/pull request NOVO contra a `main`/)
  })
})

// ————— utilidades —————

function prAberto(numero: number): PrAberto {
  return {
    numero,
    autor: AUTOR_PR_356,
    labels: LABELS_PR_356,
    corpo: CORPO_PR_356_DEV,
    rascunho: false,
    branchDoPr: 'jules-123-abc',
    branchNoRepoDoProjeto: true,
    mergeable: false,
    verificacao: 'verde',
    paradoHaMs: 7 * DIA,
  }
}

async function rodar(over: {
  prs: PrAberto[]
  issueDoPr: (n: number) => number | null
  acoesAnteriores?: (n: number) => Promise<number>
  tarefaJaDevolvidaAFila?: (n: number) => Promise<boolean>
  abrirSessaoDeConserto?: VigiaDoPrDeps['abrirSessaoDeConserto']
  fecharPr?: VigiaDoPrDeps['fecharPr']
  avisarDono?: VigiaDoPrDeps['avisarDono']
  registrarDecisao?: VigiaDoPrDeps['registrarDecisao']
}): Promise<string> {
  return vigiarPrsOrfaos({
    listarPrsAbertos: async () => over.prs,
    prsComSessaoViva: new Set<number>(),
    issueDoPr: over.issueDoPr,
    issueAberta: async () => true,
    acoesAnteriores: over.acoesAnteriores ?? (async () => 0),
    tarefaJaDevolvidaAFila: over.tarefaJaDevolvidaAFila ?? (async () => false),
    vagasLivres: 15,
    pedirJulgamento: async () => {},
    abrirSessaoDeConserto: over.abrirSessaoDeConserto ?? (async () => true),
    fecharPr: over.fecharPr ?? (async () => true),
    avisarDono: over.avisarDono ?? (async () => true),
    registrarDecisao: over.registrarDecisao ?? (async () => undefined),
  })
}
