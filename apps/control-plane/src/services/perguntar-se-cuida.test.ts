import { describe, expect, it, vi } from 'vitest'
import {
  perguntarSeCuida,
  parseDedupKeyDeCuidaDestePedido,
  DEDUP_PREFIXO_CUIDA_DESTE_PEDIDO,
  montarMensagemDeFatosBrutos,
} from './perguntar-se-cuida.js'
import type { OrigemDoItem } from './origem-do-item.js'
import type { PrismaClient } from '@prisma/client'

describe('perguntar-se-cuida', () => {
  it('dedup keys', () => {
    expect(parseDedupKeyDeCuidaDestePedido('invalido')).toBeNull()
    expect(
      parseDedupKeyDeCuidaDestePedido(`${DEDUP_PREFIXO_CUIDA_DESTE_PEDIDO}dono/repo:42`)
    ).toEqual({ repository: 'dono/repo', numeroDoPr: 42 })
  })

  it('faz fallback quando o execute falha', async () => {
    const ask = vi.fn()
    await perguntarSeCuida(
      {
        userId: 'u1',
        projectId: 'p1',
        numeroDoPr: 42,
        repository: 'dono/repo',
        origem: 'dependabot' as OrigemDoItem,
        contexto: { entrega: 'a', ciclo: 'b', decisoes: [], lacunas: [] },
        contextoPr: { titulo: 'Fix it', idadeDias: 10, estadoCi: 'success', conflitos: false },
      },
      {
        agentQuestion: { ask },
        execute: { jules: vi.fn().mockRejectedValue(new Error('fail')) } as unknown as never,
      }
    )

    expect(ask).toHaveBeenCalledWith(
      'u1',
      'p1',
      expect.objectContaining({
        text: expect.stringContaining('Pull Request #42'),
        options: expect.arrayContaining([
          { label: '✍️ Outro (respondo por texto)', value: '__gitorch_free_text__' },
        ]),
      })
    )
  })

  it('a idade em texto (horas) tem precedência sobre "N dias" na mensagem ao dono', () => {
    const msg = montarMensagemDeFatosBrutos({
      numeroDoPr: 42,
      repository: 'dono/repo',
      origem: 'dependabot' as OrigemDoItem,
      contexto: { entrega: 'a', ciclo: 'b', decisoes: [], lacunas: [] },
      contextoPr: {
        titulo: 'Fix it',
        idadeDias: 0,
        idadeTexto: '5 horas',
        estadoCi: 'success',
        conflitos: false,
      },
    })
    expect(msg.text).toContain('Idade: 5 horas')
    expect(msg.text).not.toContain('0 dias')
  })

  it('issue #877: raw fallback (montarMensagemDeFatosBrutos) inclui o grafo de vínculos quando historicoGitorch está presente', () => {
    const msg = montarMensagemDeFatosBrutos({
      numeroDoPr: 42,
      repository: 'dono/repo',
      origem: 'dependabot' as OrigemDoItem,
      contexto: { entrega: 'a', ciclo: 'b', decisoes: [], lacunas: [] },
      contextoPr: {
        titulo: 'Fix it',
        idadeDias: 10,
        estadoCi: 'success',
        conflitos: false,
        historicoGitorch: [
          'Milestone: Sprint Grafo 877 (prazo sem prazo, OPEN)',
          'Labels: grafo-877',
        ],
      },
    })

    expect(msg.text).toContain('Sprint Grafo 877')
    expect(msg.text).toContain('grafo-877')
  })

  it('issue #877: perguntarSeCuida busca o grafo de vínculos (montarContextoDoItem) quando prisma é passado e historicoGitorch ainda não veio do chamador — chega no prompt do motor', async () => {
    const ask = vi.fn()
    const prompts: string[] = []
    const execute = vi.fn(async (prompt: string) => {
      prompts.push(prompt)
      return JSON.stringify({
        resumo_do_pr: 'resumo',
        motivo_da_espera: 'motivo',
        recomendacao_do_agente: 'recomendacao',
        opcoes_sob_medida: [{ label: 'Mergear', action: 'merge' }],
      })
    })
    const prisma = {
      repoItem: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'item-1',
          projectId: 'p1',
          tipo: 'pr',
          numero: 42,
          estado: { status: 'aberto' },
          origem: 'dependabot',
          issueNumber: null,
          entendimento: null,
          vinculos: {
            hierarquia: { parents: [], subIssues: [] },
            milestone: { title: 'Sprint Grafo 877', number: 9, dueOn: null, state: 'OPEN' },
            projectFields: [],
            labelsAndAssignees: { labels: ['grafo-877'], assignees: [] },
            prsLigados: { closedByPullRequests: [], crossReferencedPullRequests: [] },
            sessoesJules: [],
            qaReview: null,
            statusCheckRollup: null,
          },
        }),
      },
    } as unknown as Pick<PrismaClient, 'repoItem'>

    await perguntarSeCuida(
      {
        userId: 'u1',
        projectId: 'p1',
        numeroDoPr: 42,
        repository: 'dono/repo',
        origem: 'dependabot' as OrigemDoItem,
        contexto: { entrega: 'a', ciclo: 'b', decisoes: [], lacunas: [] },
        contextoPr: { titulo: 'Fix it', idadeDias: 10, estadoCi: 'success', conflitos: false },
      },
      { agentQuestion: { ask }, execute, prisma }
    )

    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Sprint Grafo 877')
    expect(prompts[0]).toContain('grafo-877')
  })
})
