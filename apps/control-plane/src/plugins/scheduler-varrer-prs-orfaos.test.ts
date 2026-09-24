import { describe, it, expect, vi } from 'vitest'
import { decidirAcaoNoPrOrfaoIntegrado } from '../services/decisao-do-vigia.js'
import type { PrismaClient } from '@prisma/client'
import type { VigiaDoPrDeps } from '../services/vigia-do-pr.js'
import { MARCA_DO_PARECER, MARCA_DE_APROVACAO } from '../services/parecer-do-qa.js'

function buildDepsVigia(
  overrides: Partial<Parameters<NonNullable<VigiaDoPrDeps['decidirAcaoNoPrOrfao']>>[0]> = {}
) {
  return {
    numero: 42,
    sinais: { autor: 'jules', labels: ['jules'], corpo: null },
    temSessaoViva: false,
    issueNumber: 10,
    rascunho: false,
    issueAberta: true,
    mergeable: true,
    verificacao: 'verde' as const,
    paradoHaMs: 4 * 24 * 60 * 60 * 1000,
    acoesAnteriores: 0,
    podeAbrirSessao: true,
    branchDoPr: 'ramo',
    branchNoRepoDoProjeto: true,
    ...overrides,
  }
}

describe('decidirAcaoNoPrOrfaoIntegrado - Regras de Mesclagem', () => {
  const agora = new Date('2026-09-15T12:00:00.000Z')
  const projeto = { id: 'proj-1', wingId: 'org/repo', devPlan: 'free' }
  const token = 'gh-token'

  function config(policy: string) {
    return { cuidaPorOrigem: { jules: policy } }
  }

  function getPrismaMock(entendimento: boolean, issueState: Record<string, unknown> = {}) {
    return {
      repoItem: {
        findUnique: vi.fn(async () => ({
          numero: 10,
          origem: 'jules',
          estado: {
            rascunho: false,
            ultimoCommitEm: null,
            fechadoEAbandonado: false,
            ...issueState,
          },
          entendimento: entendimento ? { ok: true } : null,
          id: 'issue-1',
          projectId: 'proj-1',
          tipo: 'issue',
          htmlUrl: 'x',
          title: 'x',
          body: 'x',
          state: 'open',
          peso: null,
          createdAt: new Date(),
          closedAt: null,
          mergedAt: null,
        })),
      },
    } as unknown as PrismaClient
  }

  it('aprovado + CI verde + mesclavel mescla', async () => {
    const ghGet = vi.fn(async (url) => {
      if (url === '/repos/org/repo/pulls/42/reviews?per_page=100') {
        return [{ body: `${MARCA_DE_APROVACAO}\n${MARCA_DO_PARECER}`, commit_id: 'sha1' }]
      }
      if (url === '/repos/org/repo/pulls/42') return { head: { sha: 'sha1' } }
      if (url === '/repos/org/repo') return { private: true }
      return null
    })
    const ghSend = vi.fn(async () => ({}))

    const result = await decidirAcaoNoPrOrfaoIntegrado({
      runtimeConfig: config('sim'),
      agora,
      projeto,
      token,
      depsVigia: buildDepsVigia(),
      prisma: getPrismaMock(true),
      ghGet,
      ghSend,
      registrarNoPainel: vi.fn(),
      onWarn: vi.fn(),
    })

    expect(result).toEqual({ acao: 'ignorar', motivo: 'Mesclado com sucesso' })
    expect(ghSend).toHaveBeenCalledWith(
      'PUT',
      '/repos/org/repo/pulls/42/merge',
      token,
      expect.any(Object)
    )
  })

  it('QA pede mudancas nao mescla e acompanha', async () => {
    const ghGet = vi.fn(async (url) => {
      if (url === '/repos/org/repo/pulls/42/reviews?per_page=100') {
        return [
          {
            body: `reprovado\n${MARCA_DO_PARECER}\n<!-- gitorch:qa:reprovado-pelo-portao -->`,
            commit_id: 'sha1',
          },
        ]
      }
      if (url === '/repos/org/repo/pulls/42') return { head: { sha: 'sha1' } }
      return null
    })

    const result = await decidirAcaoNoPrOrfaoIntegrado({
      runtimeConfig: config('sim'),
      agora,
      projeto,
      token,
      depsVigia: buildDepsVigia(),
      prisma: getPrismaMock(true),
      ghGet,
      ghSend: vi.fn(),
      registrarNoPainel: vi.fn(),
      onWarn: vi.fn(),
    })

    expect(result.acao).toBe('ignorar')
    expect(result.motivo).toMatch(/aguardando julgamento/)
  })

  it('parecer em sha antigo nao mescla e aciona novo julgamento', async () => {
    const ghGet = vi.fn(async (url) => {
      if (url === '/repos/org/repo/pulls/42/reviews?per_page=100') {
        return [{ body: `${MARCA_DE_APROVACAO}\n${MARCA_DO_PARECER}`, commit_id: 'sha-velho' }]
      }
      if (url === '/repos/org/repo/pulls/42') return { head: { sha: 'sha-novo' } }
      return null
    })

    const result = await decidirAcaoNoPrOrfaoIntegrado({
      runtimeConfig: config('sim'),
      agora,
      projeto,
      token,
      depsVigia: buildDepsVigia(),
      prisma: getPrismaMock(true),
      ghGet,
      ghSend: vi.fn(),
      registrarNoPainel: vi.fn(),
      onWarn: vi.fn(),
    })

    expect(result).toEqual({
      acao: 'pedir-julgamento',
      motivo: expect.stringContaining('aguardando julgamento, QA acionado'),
    })
  })

  it('CI vermelho nao mescla', async () => {
    const result = await decidirAcaoNoPrOrfaoIntegrado({
      runtimeConfig: config('sim'),
      agora,
      projeto,
      token,
      depsVigia: buildDepsVigia({ verificacao: 'vermelha' }),
      prisma: getPrismaMock(true),
      ghGet: vi.fn(),
      ghSend: vi.fn(),
      registrarNoPainel: vi.fn(),
      onWarn: vi.fn(),
    })
    expect(result.acao).toBe('retomar')
  })

  it('rascunho nao mescla', async () => {
    const result = await decidirAcaoNoPrOrfaoIntegrado({
      runtimeConfig: config('sim'),
      agora,
      projeto,
      token,
      depsVigia: buildDepsVigia({ rascunho: true }),
      prisma: getPrismaMock(true, { rascunho: true, ultimoCommitEm: agora.toISOString() }),
      ghGet: vi.fn(),
      ghSend: vi.fn(),
      registrarNoPainel: vi.fn(),
      onWarn: vi.fn(),
    })
    expect(result.acao).toBe('ignorar')
    expect(result.motivo).toMatch(/em construção/)
  })

  it('politica nao nao mescla (kill switch)', async () => {
    const result = await decidirAcaoNoPrOrfaoIntegrado({
      runtimeConfig: config('nao'),
      agora,
      projeto,
      token,
      depsVigia: buildDepsVigia(),
      prisma: getPrismaMock(true),
      ghGet: vi.fn(),
      ghSend: vi.fn(),
      registrarNoPainel: vi.fn(),
      onWarn: vi.fn(),
    })
    expect(result.acao).toBe('ignorar')
    expect(result.motivo).toMatch(/configurada para não cuidar/)
  })

  it('sem tarefa aceita nao mescla (entendimentoCompleto=false)', async () => {
    const ghGet = vi.fn(async (url) => {
      if (url === '/repos/org/repo/pulls/42/reviews?per_page=100') {
        return [{ body: `${MARCA_DE_APROVACAO}\n${MARCA_DO_PARECER}`, commit_id: 'sha1' }]
      }
      if (url === '/repos/org/repo/pulls/42') return { head: { sha: 'sha1' } }
      return null
    })
    const result = await decidirAcaoNoPrOrfaoIntegrado({
      runtimeConfig: config('sim'),
      agora,
      projeto,
      token,
      depsVigia: buildDepsVigia(),
      prisma: getPrismaMock(false),
      ghGet,
      ghSend: vi.fn(),
      registrarNoPainel: vi.fn(),
      onWarn: vi.fn(),
    })
    expect(result.acao).toBe('ignorar')
    expect(result.motivo).toMatch(
      /Falha na mesclagem segura: o QA aprovou sem registrar o entendimento do pedido/
    )
  })
})
