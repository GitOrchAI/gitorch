import { describe, it, expect, vi } from 'vitest'
import { decidirAcaoNoPrOrfaoIntegrado } from '../services/decisao-do-vigia.js'
import type { PrismaClient } from '@prisma/client'
import type { VigiaDoPrDeps } from '../services/vigia-do-pr.js'

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

describe('decidirAcaoNoPrOrfaoIntegrado', () => {
  const agora = new Date('2026-09-15T12:00:00.000Z')
  const projeto = { id: 'proj-1', wingId: 'org/repo' }
  const token = 'gh-token'
  const runtimeConfig = {
    // Configura a origem "jules" para cuidar de ponta a ponta
    cuidado_por_origem: { jules: 'sim' },
  }

  function getPrismaMock(issueState: { rascunho: boolean; ultimoCommitEm: string | null }) {
    return {
      repoItem: {
        findUnique: vi.fn(
          async (args: { where?: { projectId_tipo_numero?: { numero?: number } } }) => {
            if (args?.where?.projectId_tipo_numero?.numero === 10) {
              return {
                numero: 10,
                origem: 'jules',
                estado: {
                  rascunho: issueState.rascunho,
                  ultimoCommitEm: issueState.ultimoCommitEm,
                },
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
                fechadoEAbandonado: false,
              }
            }
            return null
          }
        ),
      },
    } as unknown as PrismaClient
  }

  it('(1) PR vazio confirmado (changed_files === 0 via GET individual) -> fecha', async () => {
    const depsVigia = buildDepsVigia({ issueAberta: false })
    const ghGet = vi.fn(async (url) => {
      if (url === '/repos/org/repo/pulls/42') {
        return { changed_files: 0 }
      }
      return null
    })

    const result = await decidirAcaoNoPrOrfaoIntegrado({
      runtimeConfig,
      agora,
      projeto,
      token,
      depsVigia,
      prisma: getPrismaMock({ rascunho: false, ultimoCommitEm: null }),
      ghGet,
      ghSend: vi.fn(),
      registrarNoPainel: vi.fn(),
      onWarn: vi.fn(),
    })

    expect(result).toEqual({
      acao: 'fechar',
      motivo: 'a tarefa #10 já está fechada',
    })
    expect(ghGet).toHaveBeenCalledWith('/repos/org/repo/pulls/42', 'gh-token')
  })

  it('(2) issue fechada mas PR com alteracoes reais -> NAO fecha', async () => {
    const depsVigia = buildDepsVigia({ issueAberta: false })
    const ghGet = vi.fn(async (url) => {
      if (url === '/repos/org/repo/pulls/42') {
        return { changed_files: 1 }
      }
      return null
    })

    const result = await decidirAcaoNoPrOrfaoIntegrado({
      runtimeConfig,
      agora,
      projeto,
      token,
      depsVigia,
      prisma: getPrismaMock({ rascunho: false, ultimoCommitEm: null }),
      ghGet,
      ghSend: vi.fn(),
      registrarNoPainel: vi.fn(),
      onWarn: vi.fn(),
    })

    expect(result).toEqual({
      acao: 'ignorar',
      motivo:
        '#42: issue fechada mas PR com alterações reais (changed_files > 0 ou desconhecido), mantendo aberto',
    })
  })

  it('(3) changed_files desconhecido -> NAO fecha', async () => {
    const depsVigia = buildDepsVigia({ issueAberta: false })
    const ghGet = vi.fn(async (url) => {
      if (url === '/repos/org/repo/pulls/42') {
        return { changed_files: undefined }
      }
      return null
    })

    const result = await decidirAcaoNoPrOrfaoIntegrado({
      runtimeConfig,
      agora,
      projeto,
      token,
      depsVigia,
      prisma: getPrismaMock({ rascunho: false, ultimoCommitEm: null }),
      ghGet,
      ghSend: vi.fn(),
      registrarNoPainel: vi.fn(),
      onWarn: vi.fn(),
    })

    expect(result).toEqual({
      acao: 'ignorar',
      motivo:
        '#42: issue fechada mas PR com alterações reais (changed_files > 0 ou desconhecido), mantendo aberto',
    })
  })

  it('(4) retomar aciona a MESMA funcao de abertura de sessao do vigia antigo (retorna objeto `retomar` e passará a abrirSessaoDeConserto)', async () => {
    const depsVigia = buildDepsVigia({ mergeable: false }) // causa conflito, e origem='jules'

    const result = await decidirAcaoNoPrOrfaoIntegrado({
      runtimeConfig,
      agora,
      projeto,
      token,
      depsVigia,
      prisma: getPrismaMock({ rascunho: false, ultimoCommitEm: null }),
      ghGet: vi.fn(),
      ghSend: vi.fn(),
      registrarNoPainel: vi.fn(),
      onWarn: vi.fn(),
    })

    expect(result).toEqual({
      acao: 'retomar',
      issueNumber: 10,
      causa: 'conflito',
      pedido: 'Traga a base para o seu ramo e resolva o conflito do pull request #42.',
      branchDoPr: 'ramo',
      motivo: '#42: conflito, abrindo sessão nova',
    })
  })

  it('(5) perguntar-se-cuida e mesclar nunca resultam em escalar (mapiam para ignorar por enquanto)', async () => {
    // Para perguntar-se-cuida: configuracao 'perguntar' e issue null pra disparar rápido
    let result = await decidirAcaoNoPrOrfaoIntegrado({
      runtimeConfig: { cuidaPorOrigem: { jules: 'perguntar' } },
      agora,
      projeto,
      token,
      depsVigia: buildDepsVigia({
        issueNumber: null,
        origem: 'jules',
      } as unknown as Partial<Parameters<NonNullable<VigiaDoPrDeps['decidirAcaoNoPrOrfao']>>[0]>),
      prisma: getPrismaMock({ rascunho: false, ultimoCommitEm: null }),
      ghGet: vi.fn(),
      ghSend: vi.fn(),
      registrarNoPainel: vi.fn(),
      onWarn: vi.fn(),
    })
    expect(result).toEqual({
      acao: 'ignorar',
      motivo: 'tarefa 3.10: fluxo de perguntar se cuida não implementado no scheduler',
    })

    // Para mesclar: verificacao verde, mergeable true, entendimentoCompleto e QA veredito
    const depsParaMesclar = buildDepsVigia({
      origem: 'jules',
      entendimentoCompleto: true,
      vereditoDoQa: 'approve',
    } as Partial<Parameters<NonNullable<VigiaDoPrDeps['decidirAcaoNoPrOrfao']>>[0]>)

    result = await decidirAcaoNoPrOrfaoIntegrado({
      runtimeConfig,
      agora,
      projeto,
      token,
      depsVigia: depsParaMesclar,
      prisma: getPrismaMock({ rascunho: false, ultimoCommitEm: null }),
      ghGet: vi.fn(),
      ghSend: vi.fn(),
      registrarNoPainel: vi.fn(),
      onWarn: vi.fn(),
    })
    expect(result).toEqual({
      acao: 'ignorar',
      motivo: 'tarefa 3.10: mesclagem automática segura não implementada no scheduler',
    })
  })
})
