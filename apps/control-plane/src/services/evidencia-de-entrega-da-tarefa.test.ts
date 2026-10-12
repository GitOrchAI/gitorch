import { describe, expect, it, vi } from 'vitest'
import {
  buscarPrsQueCitamATarefa,
  criarDepsDaEvidencia,
  textoCitaATarefa,
  type PrismaDaEvidencia,
} from './evidencia-de-entrega-da-tarefa.js'
import { coletarEvidenciaDaTarefa } from './suspeita-de-tarefa-resolvida.js'

const REPO = 'org/repo'

describe('textoCitaATarefa', () => {
  it.each([
    ['Implement issue 874', true],
    ['Implements issues 874', true],
    ['Closes #874', true],
    ['Resolve a tarefa #874 do quadro', true],
    ['veja https://github.com/org/repo/issues/874', true],
    ['veja ORG/Repo#874', true],
    ['mexe em issues/874 também', true],
    ['Closes #8740', false],
    ['Closes #1874', false],
    ['issue 8740', false],
    ['Closes outro/repo#874', false],
    ['veja https://github.com/outro/repo/issues/874', false],
    ['veja https://github.com/org/repo/pull/874', false],
    ['versão 874 do pacote', false],
    ['', false],
  ])('%j -> %s', (texto, esperado) => {
    expect(textoCitaATarefa(texto, REPO, 874)).toBe(esperado)
  })
})

describe('buscarPrsQueCitamATarefa', () => {
  const CRIADA = new Date('2026-01-10T10:00:00Z')
  const item = (parcial: Record<string, unknown>) => ({
    number: 903,
    title: 'Implement issue 874',
    body: '',
    repository_url: 'https://api.github.com/repos/org/repo',
    pull_request: { merged_at: '2026-01-11T00:00:00Z' },
    ...parcial,
  })
  const buscar = (itens: unknown[]) => {
    const lerGitHub = vi.fn(async (_caminho: string) => ({ items: itens }))
    return {
      lerGitHub,
      resultado: buscarPrsQueCitamATarefa({
        lerGitHub,
        repositorio: REPO,
        numero: 874,
        criadaEm: CRIADA,
        ramoPadrao: async () => 'main',
      }),
    }
  }

  it('uma chamada de busca, restrita ao repositório, a PRs mesclados na branch padrão', async () => {
    const { lerGitHub, resultado } = buscar([item({})])
    const r = await resultado
    expect(r).toEqual([{ pullRequest: 903, mergedAt: new Date('2026-01-11T00:00:00Z') }])
    expect(lerGitHub).toHaveBeenCalledTimes(1)
    const caminho = decodeURIComponent(lerGitHub.mock.calls[0]![0])
    expect(caminho).toContain('/search/issues')
    expect(caminho).toContain('repo:org/repo')
    expect(caminho).toContain('is:pr')
    expect(caminho).toContain('is:merged')
    expect(caminho).toContain('base:main')
  })

  it('o título "Implement issue 874" basta; a citação pode estar só no corpo', async () => {
    const { resultado } = buscar([item({ number: 1, title: 'Outra coisa', body: 'Closes #874' })])
    expect((await resultado).map((e) => e.pullRequest)).toEqual([1])
  })

  it('PR não mesclado não conta', async () => {
    const { resultado } = buscar([item({ pull_request: { merged_at: null } })])
    expect(await resultado).toEqual([])
  })

  it('PR mesclado antes de a tarefa nascer não conta', async () => {
    const { resultado } = buscar([item({ pull_request: { merged_at: '2026-01-09T00:00:00Z' } })])
    expect(await resultado).toEqual([])
  })

  it('PR de outro repositório não conta', async () => {
    const { resultado } = buscar([
      item({ repository_url: 'https://api.github.com/repos/outro/repo' }),
    ])
    expect(await resultado).toEqual([])
  })

  it('PR que cita a tarefa de OUTRO repositório não conta', async () => {
    const { resultado } = buscar([item({ title: 'Implement outro/repo#874', body: '' })])
    expect(await resultado).toEqual([])
  })

  it('falha da busca propaga: quem chama não decide', async () => {
    const lerGitHub = vi.fn(async () => {
      throw new Error('GitHub GET /search/issues falhou (403)')
    })
    await expect(
      buscarPrsQueCitamATarefa({
        lerGitHub,
        repositorio: REPO,
        numero: 874,
        criadaEm: CRIADA,
        ramoPadrao: async () => 'main',
      })
    ).rejects.toThrow(/403/)
  })
})

describe('a evidência é do PROJETO e da tarefa', () => {
  type Linha = {
    projectId: string
    issueNumber: number
    pullRequestNumber: number | null
    mergeCommitSha: string | null
    closedReason: string | null
    closedAt: Date | null
    updatedAt: Date
  }
  const dia = (d: number) => new Date(Date.UTC(2026, 0, d))
  // Dois projetos com a MESMA tarefa e o MESMO número de PR: só o filtro por
  // projeto separa um do outro.
  const linhas: Linha[] = [
    {
      projectId: 'proj-a',
      issueNumber: 7,
      pullRequestNumber: 42,
      mergeCommitSha: 'aaa',
      closedReason: 'merged',
      closedAt: dia(11),
      updatedAt: dia(11),
    },
    {
      projectId: 'proj-b',
      issueNumber: 7,
      pullRequestNumber: 42,
      mergeCommitSha: 'bbb',
      closedReason: 'merged',
      closedAt: dia(12),
      updatedAt: dia(12),
    },
    {
      projectId: 'proj-b',
      issueNumber: 7,
      pullRequestNumber: 99,
      mergeCommitSha: null,
      closedReason: null,
      closedAt: null,
      updatedAt: dia(13),
    },
  ]

  function prismaFake(): PrismaDaEvidencia {
    return {
      devSession: {
        findMany: async (args) =>
          linhas.filter(
            (l) =>
              l.projectId === args.where.projectId &&
              l.issueNumber === args.where.issueNumber &&
              (l.mergeCommitSha !== null || l.closedReason === 'merged')
          ),
        count: async (args) =>
          linhas.filter(
            (l) =>
              l.projectId === args.where.projectId &&
              l.issueNumber === args.where.issueNumber &&
              l.closedAt === null
          ).length,
      },
      repoItem: {
        findUnique: async (args) =>
          args.where.projectId_tipo_numero.projectId === 'proj-a'
            ? { vinculos: { prsLigados: { closedByPullRequests: [5, 'x', 6] } } }
            : null,
      },
    }
  }

  const montar = (projectId: string) =>
    criarDepsDaEvidencia({
      prisma: prismaFake(),
      projectId,
      repositorio: REPO,
      issueNumber: 7,
      lerGitHub: async (caminho) => {
        const m = /\/pulls\/(\d+)$/.exec(caminho)
        if (m) {
          return {
            merged: true,
            merged_at: '2026-01-11T00:00:00Z',
            base: { ref: 'main', repo: { default_branch: 'main' } },
          }
        }
        return []
      },
    })

  it('as sessões mescladas vêm só do projeto da tarefa', async () => {
    const a = await montar('proj-a').sessoesMescladas()
    expect(a).toEqual([{ pullRequest: 42, mergedAt: dia(11) }])
    const b = await montar('proj-b').sessoesMescladas()
    expect(b).toEqual([{ pullRequest: 42, mergedAt: dia(12) }])
  })

  it('trabalho em andamento é do projeto, não de outro com o mesmo número de tarefa', async () => {
    expect(await montar('proj-a').existeTrabalhoEmAndamento()).toBe(false)
    expect(await montar('proj-b').existeTrabalhoEmAndamento()).toBe(true)
  })

  it('PRs ligados na ficha só os numéricos, e só da ficha do projeto', async () => {
    expect(await montar('proj-a').prsLigadosNaFicha()).toEqual([5, 6])
    expect(await montar('proj-b').prsLigadosNaFicha()).toEqual([])
  })

  it('a evidência coletada de um projeto não traz o PR do outro', async () => {
    const evidencia = await coletarEvidenciaDaTarefa(montar('proj-a'))
    expect(evidencia.entregas.map((e) => e.pullRequest).sort()).toEqual([42, 5, 6].sort())
    expect(evidencia.trabalhoEmAndamento).toBe(false)
  })

  it('PR que não é da branch padrão não vira entrega', async () => {
    const deps = criarDepsDaEvidencia({
      prisma: prismaFake(),
      projectId: 'proj-a',
      repositorio: REPO,
      issueNumber: 7,
      lerGitHub: async () => ({
        merged: true,
        merged_at: '2026-01-11T00:00:00Z',
        base: { ref: 'feature/x', repo: { default_branch: 'main' } },
      }),
    })
    await expect(deps.lerPullRequest(42)).resolves.toMatchObject({ baseEhPadrao: false })
  })

  it('PR inexistente (404) vira null; outro erro propaga', async () => {
    const com = (status: number) =>
      criarDepsDaEvidencia({
        prisma: prismaFake(),
        projectId: 'proj-a',
        repositorio: REPO,
        issueNumber: 7,
        lerGitHub: async () => {
          throw Object.assign(new Error('falhou'), { status })
        },
      })
    await expect(com(404).lerPullRequest(42)).resolves.toBeNull()
    await expect(com(500).lerPullRequest(42)).rejects.toThrow('falhou')
  })
})
