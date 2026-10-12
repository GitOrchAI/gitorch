import { describe, it, expect, vi } from 'vitest'
import { decidirAcaoNoPrOrfaoIntegrado } from '../services/decisao-do-vigia.js'
import type { PrismaClient } from '@prisma/client'
import type { VigiaDoPrDeps } from '../services/vigia-do-pr.js'
import { MARCA_DO_PARECER, MARCA_DE_APROVACAO } from '../services/parecer-do-qa.js'
import { guardaPorRepositorio } from '../services/guarda-de-autonomia.js'
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
      guardaDeSeguranca: async () => false,
      runtimeConfig: {},
      agora: new Date(),
      projeto: { id: 'p1', wingId: 'repo' },
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
  const projeto = { id: 'proj-1', wingId: 'org/repo' }
  const token = 'gh-token'

  function config(policy: string) {
    return { cuidaPorOrigem: { jules: policy } }
  }

  function getPrismaMock(
    entendimento: boolean,
    issueState: Record<string, unknown> = {},
    origem = 'jules_gitorch'
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
        return { head: { sha: 'sha1', ref: 'feat/entrega' }, base: { ref: 'main' } }
      if (url === '/repos/org/repo') return { private: true, default_branch: 'main' }
      if (url.startsWith('/repos/org/repo/commits/sha1/check-runs')) return CI_VERDE
      if (url.startsWith('/repos/org/repo/actions/runs?head_sha=sha1')) return SEM_WORKFLOW_RODANDO
      return null
    })
    const ghSend = vi.fn(async () => ({}))

    const result = await decidirAcaoNoPrOrfaoIntegrado({
      guardaDeSeguranca: async () => false,
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

  it('dois projetos no MESMO repositório: o merge do dev usa a autonomia do projeto que decide', async () => {
    const niveis: Record<string, string> = { 'proj-cuidar': 'cuidar', 'proj-olhar': 'so_olhar' }
    const chamadasAoGithub: string[] = []
    const guardado = guardaPorRepositorio(
      (async (url: string, init?: RequestInit) => {
        chamadasAoGithub.push(`${init?.method ?? 'GET'} ${url}`)
        return new Response('{}', { status: 200 })
      }) as unknown as typeof fetch,
      {
        nivelDoRepositorio: async (_repo, id) => (id ? (niveis[id] ?? null) : null),
        nossosRepositorios: new Set(),
      }
    )
    const decidir = async (id: string) => {
      const ghGet = vi.fn(async (url: string) => {
        if (url === '/repos/org/repo/pulls/42/reviews?per_page=100') {
          return [{ body: `${MARCA_DE_APROVACAO}\n${MARCA_DO_PARECER}`, commit_id: 'sha1' }]
        }
        if (url === '/repos/org/repo/pulls/42')
          return { head: { sha: 'sha1', ref: 'feat/entrega' }, base: { ref: 'main' } }
        if (url === '/repos/org/repo') return { private: true, default_branch: 'main' }
        if (url.startsWith('/repos/org/repo/commits/sha1/check-runs')) return CI_VERDE
        if (url.startsWith('/repos/org/repo/actions/runs?head_sha=sha1'))
          return SEM_WORKFLOW_RODANDO
        return null
      })
      const ghSend = async (m: string, c: string, _t: string, b: unknown) => {
        await guardado(`https://api.github.com${c}`, { method: m, body: JSON.stringify(b) })
        return {}
      }
      return decidirAcaoNoPrOrfaoIntegrado({
        guardaDeSeguranca: async () => false,
        runtimeConfig: config('sim'),
        agora,
        projeto: { id, wingId: 'org/repo' },
        token,
        depsVigia: buildDepsVigia(),
        prisma: getPrismaMock(true),
        ghGet,
        ghSend,
        registrarNoPainel: vi.fn(),
        onWarn: vi.fn(),
      })
    }

    const doOlhar = await decidir('proj-olhar')
    expect(doOlhar).not.toEqual({ acao: 'ignorar', motivo: 'Mesclado com sucesso' })
    expect(chamadasAoGithub.filter((c) => c.startsWith('PUT'))).toHaveLength(0)

    const doCuidar = await decidir('proj-cuidar')
    expect(doCuidar).toEqual({ acao: 'ignorar', motivo: 'Mesclado com sucesso' })
    expect(chamadasAoGithub.filter((c) => c.startsWith('PUT'))).toHaveLength(1)
  })

  it('aprovado + verde na varredura, mas só um check-run skipped no instante do merge → NÃO mescla', async () => {
    const ghGet = vi.fn(async (url: string) => {
      if (url === '/repos/org/repo/pulls/42/reviews?per_page=100') {
        return [{ body: `${MARCA_DE_APROVACAO}\n${MARCA_DO_PARECER}`, commit_id: 'sha1' }]
      }
      if (url === '/repos/org/repo/pulls/42')
        return { head: { sha: 'sha1', ref: 'feat/entrega' }, base: { ref: 'main' } }
      if (url === '/repos/org/repo') return { private: true, default_branch: 'main' }
      if (url.startsWith('/repos/org/repo/commits/sha1/check-runs')) {
        return { check_runs: [{ status: 'completed', conclusion: 'skipped' }] }
      }
      if (url.startsWith('/repos/org/repo/actions/runs?head_sha=sha1')) return SEM_WORKFLOW_RODANDO
      return null
    })
    const ghSend = vi.fn(async () => ({}))

    await decidirAcaoNoPrOrfaoIntegrado({
      guardaDeSeguranca: async () => false,
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
        return { head: { sha: 'sha1', ref: 'feat/entrega' }, base: { ref: 'jules-1084-abc' } }
      }
      if (url === '/repos/org/repo') return { private: true, default_branch: 'main' }
      return null
    })
    const ghSend = vi.fn(async () => ({}))

    const result = await decidirAcaoNoPrOrfaoIntegrado({
      guardaDeSeguranca: async () => false,
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

    function ghDoDependabot(
      baseRef: string,
      workflowsAgora: unknown = SEM_WORKFLOW_RODANDO,
      ramo = 'dependabot/npm_and_yarn/x'
    ) {
      return vi.fn(async (url: string) => {
        if (url === '/repos/org/repo/pulls/42')
          return {
            user: { login: 'dependabot[bot]' },
            head: { sha: 'sha1', ref: ramo },
            base: { ref: baseRef },
          }
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
        guardaDeSeguranca: async () => false,
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
        guardaDeSeguranca: async () => false,
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

    it('ramo do aplicador de segurança no caminho expresso → NÃO mescla', async () => {
      const ghSend = vi.fn(async () => ({}))
      const result = await decidirAcaoNoPrOrfaoIntegrado({
        guardaDeSeguranca: async () => false,
        runtimeConfig: configDependabot,
        agora,
        projeto,
        token,
        depsVigia: buildDepsVigia(),
        prisma: getPrismaMock(true, {}, 'dependabot'),
        ghGet: ghDoDependabot('main', SEM_WORKFLOW_RODANDO, 'gitorch/seguranca/permissoes-ci-yml'),
        ghSend,
        registrarNoPainel: vi.fn(),
        onWarn: vi.fn(),
      })
      expect(ghSend).not.toHaveBeenCalled()
      expect(result.acao).toBe('ignorar')
      expect(result.motivo).toContain('melhoria de segurança')
    })

    it('base = outro ramo → NÃO mescla e NÃO registra "merge feito" no painel', async () => {
      const ghSend = vi.fn(async () => ({}))
      const registrarNoPainel = vi.fn()
      const result = await decidirAcaoNoPrOrfaoIntegrado({
        guardaDeSeguranca: async () => false,
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
      if (url === '/repos/org/repo/pulls/42') return { head: { sha: 'sha1', ref: 'feat/entrega' } }
      return null
    })

    const result = await decidirAcaoNoPrOrfaoIntegrado({
      guardaDeSeguranca: async () => false,
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
      guardaDeSeguranca: async () => false,
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
      guardaDeSeguranca: async () => false,
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
      guardaDeSeguranca: async () => false,
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
      guardaDeSeguranca: async () => false,
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
      guardaDeSeguranca: async () => false,
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
        return { head: { sha: 'sha1', ref: 'feat/entrega' }, base: { ref: 'main' } }
      return null
    })
    const result = await decidirAcaoNoPrOrfaoIntegrado({
      guardaDeSeguranca: async () => false,
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
      guardaDeSeguranca: async () => false,
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
      guardaDeSeguranca: async () => false,
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
      guardaDeSeguranca: async () => false,
      runtimeConfig: config('sim'),
      agora,
      projeto,
      token,
      depsVigia,
      prisma: getPrismaMock(true, { rascunho: false, ultimoCommitEm: null }),
      ghGet: vi.fn().mockImplementation(async (path: string) => {
        if (path.includes('/pulls/42/files')) return [{ filename: 'src/index.ts' }]
        if (path.includes('/commits?')) return [{ sha: 'abc', commit: { message: 'Fix' } }]
        return {
          base: { ref: 'main' },
          head: { sha: 'xyz', ref: 'feat/entrega' },
          title: 'Test PR',
        }
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
      guardaDeSeguranca: async () => false,
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
      guardaDeSeguranca: async () => false,
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

describe('decidirAcaoNoPrOrfaoIntegrado: a origem e o entendimento vêm da ficha do PR', () => {
  const agora = new Date('2026-09-15T12:00:00.000Z')
  const projeto = { id: 'proj-1', wingId: 'org/repo' }
  const token = 'gh-token'

  type Args = { where: { projectId_tipo_numero: { tipo: string; numero: number } } }

  /** Prisma que responde por (tipo, número): cada ficha só aparece se o vigia
   *  pedir exatamente ela. */
  function prismaComFichas(fichas: {
    pr?: Record<string, unknown> | null
    issue?: Record<string, unknown> | null
  }) {
    const findUnique = vi.fn(async (args: Args) => {
      const { tipo } = args.where.projectId_tipo_numero
      if (tipo === 'pr') return fichas.pr ?? null
      if (tipo === 'issue') return fichas.issue ?? null
      return null
    })
    return { prisma: { repoItem: { findUnique } } as unknown as PrismaClient, findUnique }
  }

  const estadoPadrao = { rascunho: false, ultimoCommitEm: null, fechadoEAbandonado: false }
  const entendimento = {
    deOndeVeio: 'issue 10',
    oQueMuda: 'a ficha',
    queAjusteE: 'pequeno',
    porQueExiste: 'pedido do dono',
  }

  function ghGetDeAprovado(url: string) {
    if (url === '/repos/org/repo/pulls/42/reviews?per_page=100') {
      return [{ body: `${MARCA_DE_APROVACAO}\n${MARCA_DO_PARECER}`, commit_id: 'sha1' }]
    }
    if (url === '/repos/org/repo/pulls/42')
      return { head: { sha: 'sha1', ref: 'feat/entrega' }, base: { ref: 'main' } }
    if (url === '/repos/org/repo') return { private: true, default_branch: 'main' }
    if (url.startsWith('/repos/org/repo/commits/sha1/check-runs')) return CI_VERDE
    if (url.startsWith('/repos/org/repo/actions/runs?head_sha=sha1')) return SEM_WORKFLOW_RODANDO
    return null
  }

  async function decidir(
    prisma: PrismaClient,
    over: Partial<Parameters<NonNullable<VigiaDoPrDeps['decidirAcaoNoPrOrfao']>>[0]> = {},
    cuida: string | Record<string, string> = 'sim'
  ) {
    const ghSend = vi.fn(async () => ({}))
    const registrarNoPainel = vi.fn(async () => undefined)
    const resultado = await decidirAcaoNoPrOrfaoIntegrado({
      guardaDeSeguranca: async () => false,
      runtimeConfig: { cuidaPorOrigem: typeof cuida === 'string' ? { jules: cuida } : cuida },
      agora,
      projeto,
      token,
      depsVigia: buildDepsVigia(over),
      prisma,
      ghGet: vi.fn(async (url: string) => ghGetDeAprovado(url)),
      ghSend,
      registrarNoPainel,
      onWarn: vi.fn(),
    })
    return { resultado, ghSend, registrarNoPainel }
  }

  const textosDoPainel = (registrar: { mock: { calls: unknown[][] } }): string[] =>
    registrar.mock.calls.map((c) => String(c[2]))

  it('lê a ficha do PR (tipo pr, número do PR) e nunca a da issue', async () => {
    const { prisma, findUnique } = prismaComFichas({
      pr: { origem: 'jules_gitorch', estado: estadoPadrao, entendimento },
    })
    await decidir(prisma)
    expect(findUnique).toHaveBeenCalledTimes(1)
    expect(findUnique).toHaveBeenCalledWith({
      where: { projectId_tipo_numero: { projectId: 'proj-1', tipo: 'pr', numero: 42 } },
    })
  })

  it('a origem gravada no PR chega ao motor (outro_bot nunca é julgado)', async () => {
    const { prisma } = prismaComFichas({
      pr: { origem: 'outro_bot', estado: estadoPadrao, entendimento },
      // armadilha: a ficha da issue diz que é do dev assíncrono
      issue: { origem: 'jules_gitorch', estado: estadoPadrao, entendimento },
    })
    const { resultado, ghSend } = await decidir(prisma)
    expect(resultado).toEqual({
      acao: 'ignorar',
      motivo: 'origem "outro_bot" configurada para não cuidar',
    })
    expect(ghSend).not.toHaveBeenCalled()
  })

  it('o entendimento gravado no PR chega ao motor e libera o merge', async () => {
    const { prisma } = prismaComFichas({
      pr: { origem: 'jules_gitorch', estado: estadoPadrao, entendimento },
    })
    const { resultado, ghSend } = await decidir(prisma)
    expect(resultado).toEqual({ acao: 'ignorar', motivo: 'Mesclado com sucesso' })
    expect(ghSend).toHaveBeenCalledWith(
      'PUT',
      '/repos/org/repo/pulls/42/merge',
      token,
      expect.any(Object)
    )
  })

  it('sem entendimento no PR não mescla, mesmo que a ficha da issue tenha um', async () => {
    const { prisma } = prismaComFichas({
      pr: { origem: 'jules_gitorch', estado: estadoPadrao, entendimento: null },
      issue: { origem: null, estado: estadoPadrao, entendimento },
    })
    const { ghSend } = await decidir(prisma)
    expect(ghSend).not.toHaveBeenCalledWith(
      'PUT',
      '/repos/org/repo/pulls/42/merge',
      expect.anything(),
      expect.anything()
    )
  })

  it.each([['jules_gitorch'], ['jules_fora']])(
    'origem %s com tudo em ordem mescla: é entrega do dev assíncrono',
    async (origem) => {
      const { prisma } = prismaComFichas({ pr: { origem, estado: estadoPadrao, entendimento } })
      const { resultado, ghSend } = await decidir(prisma)
      expect(resultado).toEqual({ acao: 'ignorar', motivo: 'Mesclado com sucesso' })
      expect(ghSend).toHaveBeenCalledWith(
        'PUT',
        '/repos/org/repo/pulls/42/merge',
        token,
        expect.any(Object)
      )
    }
  )

  it.each([
    ['nula', null],
    ['desconhecido', 'desconhecido'],
    ['pessoa', 'pessoa'],
    ['assistente', 'assistente'],
  ])(
    'origem %s, mesmo com rótulo do dev, entendimento, aprovação e CI verde, NÃO mescla',
    async (_nome, origem) => {
      const { prisma } = prismaComFichas({ pr: { origem, estado: estadoPadrao, entendimento } })
      // `headSha` presente e todos os baldes em "sim": nada além da origem
      // impede o motor de chegar à decisão de mesclar.
      const { resultado, ghSend } = await decidir(
        prisma,
        { headSha: 'sha1', sinais: { autor: 'alguem', labels: ['jules'], corpo: null } },
        { jules: 'sim', pessoa: 'sim', assistente: 'sim', dependabot: 'sim' }
      )
      expect(ghSend).not.toHaveBeenCalledWith(
        'PUT',
        '/repos/org/repo/pulls/42/merge',
        expect.anything(),
        expect.anything()
      )
      expect(resultado.motivo).toContain('esta entrega não foi encomendada pelo produto')
    }
  )

  it('recusa da mesclagem segura: o painel não diz que está mesclando e traz o motivo', async () => {
    const { prisma } = prismaComFichas({
      pr: { origem: 'jules_gitorch', estado: estadoPadrao, entendimento: null },
    })
    const { registrarNoPainel } = await decidir(prisma)
    const textos = textosDoPainel(registrarNoPainel)
    expect(textos.some((t) => t.includes('mesclando'))).toBe(false)
    expect(textos.some((t) => t.includes('sem registrar o entendimento do pedido'))).toBe(true)
  })

  it('mesclagem feita: o painel registra que os critérios bateram e que mesclou', async () => {
    const { prisma } = prismaComFichas({
      pr: { origem: 'jules_gitorch', estado: estadoPadrao, entendimento },
    })
    const { registrarNoPainel } = await decidir(prisma)
    const textos = textosDoPainel(registrarNoPainel)
    expect(textos.some((t) => t.includes('mesclando'))).toBe(true)
    expect(textos.some((t) => t.includes('foi mesclado com sucesso'))).toBe(true)
  })

  describe('guarda de segurança (a sondagem do dia, nunca o plano do dev)', () => {
    async function decidirComGuarda(guardaDeSeguranca: () => Promise<boolean>) {
      const { prisma } = prismaComFichas({
        pr: { origem: 'jules_gitorch', estado: estadoPadrao, entendimento },
      })
      const ghSend = vi.fn(async () => ({}))
      const ghGet = vi.fn(async (url: string) => ghGetDeAprovado(url))
      const resultado = await decidirAcaoNoPrOrfaoIntegrado({
        guardaDeSeguranca,
        runtimeConfig: { cuidaPorOrigem: { jules: 'sim' } },
        agora,
        projeto,
        token,
        depsVigia: buildDepsVigia({}),
        prisma,
        ghGet,
        ghSend,
        registrarNoPainel: vi.fn(async () => undefined),
        onWarn: vi.fn(),
      })
      return { resultado, ghSend, ghGet }
    }

    it('guarda que exige revisão: o PR aprovado e verde NÃO é mesclado', async () => {
      const guarda = vi.fn(async () => true)
      const { resultado, ghSend } = await decidirComGuarda(guarda)
      expect(guarda).toHaveBeenCalledTimes(1)
      expect(ghSend).not.toHaveBeenCalled()
      expect(resultado.motivo).not.toBe('Mesclado com sucesso')
    })

    it('guarda que não exige: o mesmo PR é mesclado', async () => {
      const guarda = vi.fn(async () => false)
      const { resultado, ghSend } = await decidirComGuarda(guarda)
      expect(guarda).toHaveBeenCalledTimes(1)
      expect(resultado).toEqual({ acao: 'ignorar', motivo: 'Mesclado com sucesso' })
      expect(ghSend).toHaveBeenCalled()
    })

    it('o vigia não lê mais a visibilidade nem a pasta de workflows por PR (a guarda resolve isso uma vez por dia)', async () => {
      const { ghGet } = await decidirComGuarda(async () => false)
      const lidos = ghGet.mock.calls.map((c) => String(c[0]))
      expect(lidos.some((u) => u.includes('/contents/'))).toBe(false)
      // a única leitura do repositório que sobra é a da branch padrão, para o porteiro do merge
      expect(lidos.filter((u) => u === '/repos/org/repo')).toHaveLength(1)
    })
  })

  it('o instante do último commit gravado no PR entra na janela de construção', async () => {
    const haUmaHora = new Date(agora.getTime() - 60 * 60_000).toISOString()
    const { prisma } = prismaComFichas({
      pr: {
        origem: 'jules_gitorch',
        estado: { ...estadoPadrao, ultimoCommitEm: haUmaHora },
        entendimento,
      },
    })
    const { resultado } = await decidir(prisma)
    expect(resultado).toEqual({ acao: 'ignorar', motivo: '#42 ainda está em construção' })
  })

  it('ficha do PR ausente não quebra: cai em desconhecido e segue o balde padrão', async () => {
    const { prisma, findUnique } = prismaComFichas({ pr: null })
    const { resultado, ghSend } = await decidir(prisma)
    expect(findUnique).toHaveBeenCalledTimes(1)
    // sem ficha não há entendimento: o motor não mescla
    expect(resultado.acao).not.toBe('escalar')
    expect(ghSend).not.toHaveBeenCalledWith(
      'PUT',
      '/repos/org/repo/pulls/42/merge',
      expect.anything(),
      expect.anything()
    )
  })

  it('PR sem tarefa de origem também lê a ficha do PR (a origem não depende da issue)', async () => {
    const { prisma, findUnique } = prismaComFichas({
      pr: { origem: 'outro_bot', estado: estadoPadrao, entendimento: null },
    })
    const { resultado } = await decidir(prisma, { issueNumber: null })
    expect(findUnique).toHaveBeenCalledWith({
      where: { projectId_tipo_numero: { projectId: 'proj-1', tipo: 'pr', numero: 42 } },
    })
    expect(resultado).toEqual({
      acao: 'ignorar',
      motivo: 'origem "outro_bot" configurada para não cuidar',
    })
  })

  describe('a cabeça do PR é relida viva na porta do merge', () => {
    const URL_DO_PR = '/repos/org/repo/pulls/42'

    /**
     * O QA aprovou 'sha1' (parecer e `headSha` da varredura). `leituraDoPr`
     * decide o que o GitHub devolve a cada leitura do PR, na ordem em que o
     * motor pede (a 1ª é a base, a última antes do merge é a cabeça viva).
     */
    async function decidirComLeituras(leituraDoPr: (chamada: number) => unknown) {
      const { prisma } = prismaComFichas({
        pr: { origem: 'jules_gitorch', estado: estadoPadrao, entendimento },
      })
      let chamadas = 0
      const ghGet = vi.fn(async (url: string) => {
        if (url === URL_DO_PR) {
          chamadas += 1
          return leituraDoPr(chamadas)
        }
        return ghGetDeAprovado(url)
      })
      const ghSend = vi.fn(async () => ({}))
      const registrarNoPainel = vi.fn(async () => undefined)
      const onWarn = vi.fn()
      const resultado = await decidirAcaoNoPrOrfaoIntegrado({
        guardaDeSeguranca: async () => false,
        runtimeConfig: { cuidaPorOrigem: { jules: 'sim' } },
        agora,
        projeto,
        token,
        depsVigia: buildDepsVigia({ headSha: 'sha1' }),
        prisma,
        ghGet,
        ghSend,
        registrarNoPainel,
        onWarn,
      })
      return { resultado, ghSend, registrarNoPainel, onWarn }
    }

    const mesclou = (ghSend: { mock: { calls: unknown[][] } }): boolean =>
      ghSend.mock.calls.some((c) => c[0] === 'PUT' && String(c[1]).endsWith('/merge'))

    it('cabeça viva igual à aprovada: mescla, e o sha do PUT é o da cabeça viva', async () => {
      const { resultado, ghSend } = await decidirComLeituras(() => ({
        head: { sha: 'sha1', ref: 'feat/entrega' },
        base: { ref: 'main' },
      }))
      expect(resultado).toEqual({ acao: 'ignorar', motivo: 'Mesclado com sucesso' })
      expect(ghSend).toHaveBeenCalledWith(
        'PUT',
        '/repos/org/repo/pulls/42/merge',
        token,
        expect.objectContaining({ sha: 'sha1' })
      )
    })

    it('cabeça viva DIFERENTE da que o QA aprovou: não chama o merge e o painel traz a recusa com motivo', async () => {
      const { resultado, ghSend, registrarNoPainel } = await decidirComLeituras(() => ({
        head: { sha: 'sha2', ref: 'feat/entrega' },
        base: { ref: 'main' },
      }))
      expect(mesclou(ghSend)).toBe(false)
      expect(resultado.acao).toBe('ignorar')
      expect(resultado.motivo).toContain('o código mudou depois da aprovação do QA')
      expect(resultado.motivo).toContain('sha1')
      expect(resultado.motivo).toContain('sha2')
      const textos = textosDoPainel(registrarNoPainel)
      expect(textos.some((t) => t.includes('mesclando'))).toBe(false)
      expect(textos.some((t) => t.includes('o código mudou depois da aprovação do QA'))).toBe(true)
    })

    it('a cabeça muda entre a leitura da base e a porta do merge: não mescla', async () => {
      // A cabeça muda DEPOIS da leitura da base e antes da porta do merge.
      const { ghSend } = await decidirComLeituras((chamada) => ({
        head: { sha: chamada === 1 ? 'sha1' : 'sha2', ref: 'feat/entrega' },
        base: { ref: 'main' },
      }))
      expect(mesclou(ghSend)).toBe(false)
    })

    it('leitura viva do PR falha: não mescla, avisa e o painel traz o motivo', async () => {
      const { resultado, ghSend, registrarNoPainel, onWarn } = await decidirComLeituras(
        (chamada) => {
          if (chamada >= 2) throw new Error('github fora do ar')
          return { head: { sha: 'sha1', ref: 'feat/entrega' }, base: { ref: 'main' } }
        }
      )
      expect(mesclou(ghSend)).toBe(false)
      expect(resultado.acao).toBe('ignorar')
      expect(resultado.motivo).toContain('commit atual')
      expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('github fora do ar'))
      const textos = textosDoPainel(registrarNoPainel)
      expect(textos.some((t) => t.includes('mesclando'))).toBe(false)
      expect(textos.some((t) => t.includes('commit atual'))).toBe(true)
    })

    // O pull request do aplicador de segurança é do dono: o motor do vigia
    // nunca o mescla, mesmo com QA aprovado, verificação verde e origem "jules".
    it('pull request de segurança (ramo gitorch/seguranca/): não mescla e o painel traz o motivo', async () => {
      const { resultado, ghSend, registrarNoPainel } = await decidirComLeituras(() => ({
        head: { sha: 'sha1', ref: 'gitorch/seguranca/permissoes-ci-yml' },
        base: { ref: 'main' },
      }))
      expect(mesclou(ghSend)).toBe(false)
      expect(resultado.acao).toBe('ignorar')
      expect(resultado.motivo).toContain('melhoria de segurança')
      const textos = textosDoPainel(registrarNoPainel)
      expect(textos.some((t) => t.includes('mesclando'))).toBe(false)
    })

    it('a marca de segurança no corpo do PR basta para não mesclar', async () => {
      const { ghSend } = await decidirComLeituras(() => ({
        head: { sha: 'sha1', ref: 'feat/entrega' },
        base: { ref: 'main' },
        body: '<!-- gitorch:seguranca -->\n\n## O que muda',
      }))
      expect(mesclou(ghSend)).toBe(false)
    })

    it('leitura do PR sem o ramo: não mescla', async () => {
      const { resultado, ghSend } = await decidirComLeituras(() => ({
        head: { sha: 'sha1' },
        base: { ref: 'main' },
      }))
      expect(mesclou(ghSend)).toBe(false)
      expect(resultado.motivo).toContain('ramo')
    })

    it('leitura viva sem sha: não mescla', async () => {
      const { resultado, ghSend } = await decidirComLeituras((chamada) =>
        chamada >= 2
          ? { base: { ref: 'main' } }
          : { head: { sha: 'sha1', ref: 'feat/entrega' }, base: { ref: 'main' } }
      )
      expect(mesclou(ghSend)).toBe(false)
      expect(resultado.motivo).toContain('commit atual')
    })
  })
})
