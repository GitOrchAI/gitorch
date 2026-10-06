import { describe, it, expect, vi } from 'vitest'
import { decidirAcaoNoPrOrfaoIntegrado } from '../services/decisao-do-vigia.js'
import type { PrismaClient } from '@prisma/client'
import type { VigiaDoPrDeps } from '../services/vigia-do-pr.js'
import { MARCA_DO_PARECER, MARCA_DE_APROVACAO } from '../services/parecer-do-qa.js'
import { contextoExecutivoVazio } from '../services/contexto-executivo-da-pergunta.js'

const CI_VERDE = { check_runs: [{ status: 'completed', conclusion: 'success' }] }
const SEM_WORKFLOW_RODANDO = { workflow_runs: [{ status: 'completed', conclusion: 'success' }] }

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
    tarefaJaDevolvidaAFila: false,
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
      acoesAnteriores: 1, // MAX_ACOES_DO_VIGIA (normally would trigger escalation)
      tarefaJaDevolvidaAFila: false,
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

  const agora = new Date('2026-09-15T12:00:00.000Z')
  const projeto = { id: 'proj-1', wingId: 'org/repo', devPlan: 'free' }
  const token = 'gh-token'

  function config(policy: string) {
    return { cuidaPorOrigem: { jules: policy } }
  }

  function getPrismaMock(
    entendimento: boolean,
    issueState: Record<string, unknown> = {},
    origem = 'jules'
  ) {
    return {
      repoItem: {
        findUnique: vi.fn(async () => ({
          numero: 10,
          origem,
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
      if (url === '/repos/org/repo/pulls/42')
        return { head: { sha: 'sha1' }, base: { ref: 'main' } }
      if (url === '/repos/org/repo') return { private: true, default_branch: 'main' }
      if (url.startsWith('/repos/org/repo/commits/sha1/check-runs')) return CI_VERDE
      if (url.startsWith('/repos/org/repo/actions/runs?head_sha=sha1')) return SEM_WORKFLOW_RODANDO
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

  it('aprovado + verde na varredura, mas só um check-run skipped no instante do merge → NÃO mescla', async () => {
    const ghGet = vi.fn(async (url: string) => {
      if (url === '/repos/org/repo/pulls/42/reviews?per_page=100') {
        return [{ body: `${MARCA_DE_APROVACAO}\n${MARCA_DO_PARECER}`, commit_id: 'sha1' }]
      }
      if (url === '/repos/org/repo/pulls/42')
        return { head: { sha: 'sha1' }, base: { ref: 'main' } }
      if (url === '/repos/org/repo') return { private: true, default_branch: 'main' }
      if (url.startsWith('/repos/org/repo/commits/sha1/check-runs')) {
        return { check_runs: [{ status: 'completed', conclusion: 'skipped' }] }
      }
      if (url.startsWith('/repos/org/repo/actions/runs?head_sha=sha1')) return SEM_WORKFLOW_RODANDO
      return null
    })
    const ghSend = vi.fn(async () => ({}))

    await decidirAcaoNoPrOrfaoIntegrado({
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

    expect(ghSend).not.toHaveBeenCalledWith(
      'PUT',
      '/repos/org/repo/pulls/42/merge',
      token,
      expect.anything()
    )
  })

  it('aprovado + CI verde, mas o PR mira um ramo antigo (não a main) NÃO mescla', async () => {
    const ghGet = vi.fn(async (url) => {
      if (url === '/repos/org/repo/pulls/42/reviews?per_page=100') {
        return [{ body: `${MARCA_DE_APROVACAO}\n${MARCA_DO_PARECER}`, commit_id: 'sha1' }]
      }
      if (url === '/repos/org/repo/pulls/42') {
        return { head: { sha: 'sha1' }, base: { ref: 'jules-1084-abc' } }
      }
      if (url === '/repos/org/repo') return { private: true, default_branch: 'main' }
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

    expect(ghSend).not.toHaveBeenCalledWith(
      'PUT',
      '/repos/org/repo/pulls/42/merge',
      token,
      expect.anything()
    )
    expect(result.acao).toBe('ignorar')
    expect(result.motivo).toContain('jules-1084-abc')
    expect(result.motivo).toContain('`main`')
  })

  describe('Dependabot expresso só mescla o que mira a branch padrão', () => {
    const configDependabot = { cuidaPorOrigem: { dependabot: 'sim' } }

    function ghDoDependabot(baseRef: string, workflowsAgora: unknown = SEM_WORKFLOW_RODANDO) {
      return vi.fn(async (url: string) => {
        if (url === '/repos/org/repo/pulls/42')
          return { head: { sha: 'sha1' }, base: { ref: baseRef } }
        if (url === '/repos/org/repo') return { private: true, default_branch: 'main' }
        if (url.startsWith('/repos/org/repo/commits/sha1/check-runs')) return CI_VERDE
        if (url.startsWith('/repos/org/repo/actions/runs?head_sha=sha1')) return workflowsAgora
        return null
      })
    }

    // A leitura do vigia (minutos antes) dizia verde; no instante do merge um
    // workflow do mesmo commit ainda roda. Não pode mesclar.
    it('verde na varredura, mas workflow rodando no instante do merge → NÃO mescla', async () => {
      const ghSend = vi.fn(async () => ({}))
      const result = await decidirAcaoNoPrOrfaoIntegrado({
        runtimeConfig: configDependabot,
        agora,
        projeto,
        token,
        depsVigia: buildDepsVigia(),
        prisma: getPrismaMock(true, {}, 'dependabot'),
        ghGet: ghDoDependabot('main', { workflow_runs: [{ status: 'in_progress' }] }),
        ghSend,
        registrarNoPainel: vi.fn(),
        onWarn: vi.fn(),
      })
      expect(ghSend).not.toHaveBeenCalled()
      expect(result.acao).toBe('ignorar')
      expect(result.motivo).toContain('instante do merge')
    })

    it('base = main → mescla e registra o merge no painel', async () => {
      const ghSend = vi.fn(async () => ({}))
      const registrarNoPainel = vi.fn()
      const result = await decidirAcaoNoPrOrfaoIntegrado({
        runtimeConfig: configDependabot,
        agora,
        projeto,
        token,
        depsVigia: buildDepsVigia(),
        prisma: getPrismaMock(true, {}, 'dependabot'),
        ghGet: ghDoDependabot('main'),
        ghSend,
        registrarNoPainel,
        onWarn: vi.fn(),
      })
      expect(result.motivo).toBe('Mesclado pelo caminho expresso do Dependabot')
      expect(ghSend).toHaveBeenCalledWith(
        'PUT',
        '/repos/org/repo/pulls/42/merge',
        token,
        expect.any(Object)
      )
    })

    it('base = outro ramo → NÃO mescla e NÃO registra "merge feito" no painel', async () => {
      const ghSend = vi.fn(async () => ({}))
      const registrarNoPainel = vi.fn()
      const result = await decidirAcaoNoPrOrfaoIntegrado({
        runtimeConfig: configDependabot,
        agora,
        projeto,
        token,
        depsVigia: buildDepsVigia(),
        prisma: getPrismaMock(true, {}, 'dependabot'),
        ghGet: ghDoDependabot('release/2026'),
        ghSend,
        registrarNoPainel,
        onWarn: vi.fn(),
      })
      expect(ghSend).not.toHaveBeenCalled()
      expect(registrarNoPainel).not.toHaveBeenCalledWith(
        'proj-1',
        expect.stringContaining('dependabot-merge:'),
        expect.anything()
      )
      expect(result.acao).toBe('ignorar')
      expect(result.motivo).toContain('release/2026')
      expect(result.motivo).toContain('`main`')
    })
  })

  it('QA pede mudancas nao mescla e RETOMA', async () => {
    const ghGet = vi.fn(async (url) => {
      if (url === '/repos/org/repo/pulls/42/reviews?per_page=100') {
        return [
          {
            body: `reprovado\n${MARCA_DO_PARECER}\n<!-- gitorch:qa:reprovado-pelo-portao -->`,
            commit_id: 'sha1',
            submitted_at: new Date().toISOString(),
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
      if (url === '/repos/org/repo/pulls/42')
        return { head: { sha: 'sha1' }, base: { ref: 'main' } }
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

  it('(4) retomar aciona a MESMA funcao de abertura de sessao do vigia antigo (retorna objeto `retomar` e passará a abrirSessaoDeConserto)', async () => {
    const depsVigia = buildDepsVigia({ mergeable: false }) // causa conflito, e origem='jules'

    const result = await decidirAcaoNoPrOrfaoIntegrado({
      runtimeConfig: config('sim'),
      agora,
      projeto,
      token,
      depsVigia,
      prisma: getPrismaMock(true, { rascunho: false, ultimoCommitEm: null }),
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
      prisma: getPrismaMock(true, { rascunho: false, ultimoCommitEm: null }),
      ghGet: vi.fn(),
      ghSend: vi.fn(),
      registrarNoPainel: vi.fn(),
      onWarn: vi.fn(),
    })
    expect(result).toEqual({
      acao: 'ignorar',
      motivo: 'tarefa 3.10: dados insuficientes para perguntar',
    })
  })

  it('issue #877: fluxo completo de perguntar-se-cuida busca o grafo de vínculos da issue e completa sem quebrar', async () => {
    const agentQuestionAsk = vi.fn().mockResolvedValue(undefined)
    const findFirstMock = vi.fn().mockResolvedValue({
      id: 'issue-1',
      projectId: 'proj-1',
      tipo: 'issue',
      numero: 10,
      estado: { rascunho: false, ultimoCommitEm: null, fechadoEAbandonado: false },
      origem: 'jules',
      issueNumber: null,
      entendimento: { ok: true },
      vinculos: {
        hierarquia: { parents: [], subIssues: [] },
        milestone: null,
        projectFields: [],
        labelsAndAssignees: { labels: ['issue-877'], assignees: [] },
        prsLigados: { closedByPullRequests: [], crossReferencedPullRequests: [] },
        sessoesJules: [],
        qaReview: null,
        statusCheckRollup: null,
      },
    })
    const prisma = {
      repoItem: {
        findUnique: vi.fn().mockResolvedValue({
          numero: 10,
          origem: 'jules',
          estado: { rascunho: false, ultimoCommitEm: null, fechadoEAbandonado: false },
          entendimento: { ok: true },
          id: 'issue-1',
          projectId: 'proj-1',
          tipo: 'issue',
        }),
        findFirst: findFirstMock,
      },
    } as unknown as PrismaClient

    const result = await decidirAcaoNoPrOrfaoIntegrado({
      runtimeConfig: { cuidaPorOrigem: { jules: 'perguntar' } },
      agora,
      projeto,
      token,
      depsVigia: buildDepsVigia(),
      prisma,
      ghGet: vi.fn(),
      ghSend: vi.fn(),
      registrarNoPainel: vi.fn(),
      onWarn: vi.fn(),
      userId: 'user-1',
      agentQuestion: { ask: agentQuestionAsk },
      montarContextoExecutivo: async () => contextoExecutivoVazio(),
      depsDoContexto: {} as never,
    })

    expect(result).toEqual({
      acao: 'ignorar',
      motivo: 'pergunta executiva "cuido deste pedido?" enviada ao dono',
    })
    expect(agentQuestionAsk).toHaveBeenCalledTimes(1)
    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: 'proj-1', numero: 10 }),
      })
    )
  })
})
