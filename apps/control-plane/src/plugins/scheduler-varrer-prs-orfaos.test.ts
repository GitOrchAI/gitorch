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

describe('decidirAcaoNoPrOrfaoIntegrado', () => {
  it('retoma PR se houver REQUEST_CHANGES no HEAD atual (mesmo após duas tentativas anteriores, limit bypass)', async () => {
    const depsVigia = {
      numero: 3953,
      sinais: {
        autor: 'jules_gitorch',
        labels: ['gitorch:task', 'jules', 'gitorch:agent:qa'],
        corpo: null,
      },
      temSessaoViva: false,
      issueNumber: 3841,
      issueAberta: true,
      mergeable: true,
      verificacao: 'verde',
      paradoHaMs: 8 * 24 * 60 * 60 * 1000,
      acoesAnteriores: 2, // MAX_ACOES_DO_VIGIA (normally would trigger escalation)
      podeAbrirSessao: true,
      origem: 'desconhecido',
      branchDoPr: 'feat-zap',
      branchNoRepoDoProjeto: true,
      headSha: '42ae8dc7',
      rascunho: false,
    } as unknown as Parameters<
      NonNullable<import('../services/vigia-do-pr.js').VigiaDoPrDeps['decidirAcaoNoPrOrfao']>
    >[0]

    const ghGetMock = vi.fn().mockImplementation(async (caminho: string) => {
      if (caminho.includes('/pulls/3953/reviews')) {
        return [
          {
            body: `<!-- gitorch:qa -->\nO parecer de teste diz que a entrega nao coube inteira na janela de revisao.`,
            commit_id: '42ae8dc7',
            submitted_at: new Date(Date.now() - 1000).toISOString(),
          },
        ]
      }
      return []
    })

    const prismaMock = {
      agentQuestion: {
        findFirst: vi.fn().mockResolvedValue(null), // No pending question
      },
      event: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { createdAt: new Date(Date.now() - 5000), payload: { vigiaDoPr: { acao: 'escalar' } } },
          ]), // Escalation happened BEFORE QA review
        count: vi.fn().mockResolvedValue(0), // Count of actions since QA review is 0
      },
      repoItem: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    } as unknown as import('@prisma/client').PrismaClient

    const result = await decidirAcaoNoPrOrfaoIntegrado({
      runtimeConfig: {},
      agora: new Date(),
      projeto: { id: 'p1', wingId: 'repo', devPlan: 'free' },
      token: 'tok',
      depsVigia,
      prisma: prismaMock,
      ghGet: ghGetMock,
      ghSend: vi.fn(),
      registrarNoPainel: vi.fn(),
      onWarn: vi.fn(),
    })

    expect(result.acao).toBe('retomar')
    if (result.acao === 'retomar') {
      expect(result.pedido).toContain('Divida esta entrega')
      expect(result.pedido).toContain('partes menores')
    }
  })
})

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

  it('QA pede mudancas nao mescla e retoma (issue #873)', async () => {
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

    expect(result.acao).toBe('retomar')
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
  it('(2) issue fechada mas PR com alteracoes reais -> FECHA como substituído', async () => {
    const depsVigia = buildDepsVigia({ issueAberta: false })
    const ghGet = vi.fn(async (url) => {
      if (url === '/repos/org/repo/pulls/42') {
        return { changed_files: 1 }
      }
      return null
    })

    const result = await decidirAcaoNoPrOrfaoIntegrado({
      runtimeConfig: config('sim'),
      agora,
      projeto,
      token,
      depsVigia,
      prisma: getPrismaMock(true, { rascunho: false, ultimoCommitEm: null }),
      ghGet,
      ghSend: vi.fn(),
      registrarNoPainel: vi.fn(),
      onWarn: vi.fn(),
    })

    expect(result).toEqual({
      acao: 'fechar',
      motivo:
        'A tarefa #10 já está fechada — ela foi resolvida por outro caminho. Fechando esta entrega, que ficou para trás.',
    })
  })

  it('(3) changed_files desconhecido -> FECHA como substituído', async () => {
    const depsVigia = buildDepsVigia({ issueAberta: false })
    const ghGet = vi.fn(async (url) => {
      if (url === '/repos/org/repo/pulls/42') {
        return { changed_files: undefined }
      }
      return null
    })

    const result = await decidirAcaoNoPrOrfaoIntegrado({
      runtimeConfig: config('sim'),
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
      motivo:
        'A tarefa #10 já está fechada — ela foi resolvida por outro caminho. Fechando esta entrega, que ficou para trás.',
    })
  })

  it('(4) retomar aciona a MESMA funcao de abertura de sessao do vigia antigo (retorna objeto `retomar` e passará a abrirSessaoDeConserto)', async () => {
    const depsVigia = buildDepsVigia({ mergeable: false }) // causa conflito, e origem='jules'

    const result = await decidirAcaoNoPrOrfaoIntegrado({
      runtimeConfig: config('sim'),
      agora,
      projeto,
      token,
      depsVigia,
      prisma: getPrismaMock({ rascunho: false, ultimoCommitEm: null }),
      ghGet: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes('/pulls/42/files')) return [{ filename: 'src/index.ts' }]
        if (path.includes('/commits?')) return [{ sha: 'abc', commit: { message: 'Fix' } }]
        return { base: { ref: 'main' }, head: { sha: 'xyz' }, title: 'Test PR' }
      }),
      ghSend: vi.fn(),
      registrarNoPainel: vi.fn(),
      onWarn: vi.fn(),
    })

    expect(result.acao).toBe('retomar')
    if (result.acao === 'retomar') {
      expect(result.issueNumber).toBe(10)
      expect(result.causa).toBe('conflito')
      expect(result.pedido).toContain(
        'Traga a base para o seu ramo e resolva o conflito do pull request #42.'
      )
      // The dossier text expects #42
      expect(result.pedido).toContain('Dossiê de Conflito para o PR #42')
      expect(result.branchDoPr).toBe('ramo')
      expect(result.motivo).toBe('#42: conflito, abrindo sessão nova')
    }
  })


})