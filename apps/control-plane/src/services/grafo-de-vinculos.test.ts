import { describe, it, expect, vi } from 'vitest'
import { atualizarGrafoDeVinculos, type AtualizarGrafoDeps } from './grafo-de-vinculos.js'
import { MARCA_DO_PARECER } from './parecer-do-qa.js'

interface ClientFake {
  getIssueHierarchy: ReturnType<typeof vi.fn>
  getItemMilestone: ReturnType<typeof vi.fn>
  getProjectsV2Fields: ReturnType<typeof vi.fn>
  getItemLabelsAndAssignees: ReturnType<typeof vi.fn>
  getPullRequestCrossReferences: ReturnType<typeof vi.fn>
  getPullRequestChecksAndReview: ReturnType<typeof vi.fn>
}

function clientFake(overrides: Partial<ClientFake> = {}): ClientFake {
  return {
    getIssueHierarchy: vi.fn(async () => ({ parents: [], subIssues: [] })),
    getItemMilestone: vi.fn(async () => null),
    getProjectsV2Fields: vi.fn(async () => []),
    getItemLabelsAndAssignees: vi.fn(async () => ({ labels: [], assignees: [] })),
    getPullRequestCrossReferences: vi.fn(async () => ({
      closedByPullRequests: [],
      crossReferencedPullRequests: [],
    })),
    getPullRequestChecksAndReview: vi.fn(async () => ({ statusCheckRollup: null, qaReview: null })),
    ...overrides,
  }
}

interface PrismaFake {
  repoItemVinculos: { upsert: ReturnType<typeof vi.fn> }
  devSession: { findMany: ReturnType<typeof vi.fn> }
  linhas: Map<string, unknown>
}

function prismaFake(
  sessoes: Array<{
    sessionName: string
    issueNumber: number
    pullRequestNumber: number | null
    state: string
    closedAt: Date | null
  }>
): PrismaFake {
  const linhas = new Map<string, unknown>()
  return {
    linhas,
    devSession: { findMany: vi.fn(async () => sessoes) },
    repoItemVinculos: {
      upsert: vi.fn(
        async (args: { where: { repoItemId: string }; create: unknown; update: unknown }) => {
          linhas.set(args.where.repoItemId, args.update)
          return args.update
        }
      ),
    },
  }
}

function depsBase(overrides: Partial<AtualizarGrafoDeps> = {}): AtualizarGrafoDeps {
  const prisma = overrides.prisma ?? (prismaFake([]) as unknown as AtualizarGrafoDeps['prisma'])
  return {
    prisma,
    githubToken: 'tok',
    owner: 'GitOrchAI',
    repo: 'gitorch',
    numero: 583,
    tipo: 'pr',
    repoItemId: 'item-1',
    projectId: 'proj-1',
    client: clientFake() as unknown as AtualizarGrafoDeps['client'],
    ...overrides,
  }
}

describe('atualizarGrafoDeVinculos', () => {
  it('monta o grafo completo (tipo pr): hierarquia/milestone/projeto/labels/assignees/PRs/CI/parecer', async () => {
    const prisma = prismaFake([])
    const client = clientFake({
      getItemMilestone: vi.fn(async () => ({
        title: 'Sprint 1',
        number: 3,
        dueOn: '2026-08-13T00:00:00Z',
        state: 'OPEN',
      })),
      getProjectsV2Fields: vi.fn(async () => [
        {
          project: { id: 'PVT_1', title: 'Board' },
          status: 'Done',
          iteration: { title: 'Sprint 1', startDate: '2026-09-26', duration: 3 },
          peso: 2,
          fields: [],
        },
      ]),
      getItemLabelsAndAssignees: vi.fn(async () => ({ labels: ['bug'], assignees: ['loureng'] })),
      getPullRequestCrossReferences: vi.fn(async () => ({
        closedByPullRequests: [],
        crossReferencedPullRequests: [884],
      })),
      getPullRequestChecksAndReview: vi.fn(async () => ({
        statusCheckRollup: 'SUCCESS',
        qaReview: {
          state: 'APPROVED',
          headSha: 'sha1',
          resumo: `${MARCA_DO_PARECER}\nok`,
          submittedAt: '2026-09-02T00:00:00Z',
        },
      })),
    })

    await atualizarGrafoDeVinculos(
      depsBase({
        prisma: prisma as unknown as AtualizarGrafoDeps['prisma'],
        client: client as unknown as AtualizarGrafoDeps['client'],
        tipo: 'pr',
        numero: 583,
      })
    )

    expect(prisma.repoItemVinculos.upsert).toHaveBeenCalledTimes(1)
    const gravado = prisma.linhas.get('item-1') as Record<string, unknown>
    expect(gravado['milestone']).toEqual({
      title: 'Sprint 1',
      number: 3,
      dueOn: '2026-08-13T00:00:00Z',
      state: 'OPEN',
    })
    expect(gravado['labelsAndAssignees']).toEqual({ labels: ['bug'], assignees: ['loureng'] })
    expect(gravado['prsLigados']).toEqual({
      closedByPullRequests: [],
      crossReferencedPullRequests: [884],
    })
    expect(gravado['statusCheckRollup']).toBe('SUCCESS')
    expect(gravado['qaReview']).toEqual({
      state: 'APPROVED',
      headSha: 'sha1',
      resumo: `${MARCA_DO_PARECER}\nok`,
      submittedAt: '2026-09-02T00:00:00Z',
    })
  })

  it('tipo issue: sessoesJules filtra pelas sessões com issueNumber igual ao número do item', async () => {
    const sessoes = [
      {
        sessionName: 'sessions/1',
        issueNumber: 580,
        pullRequestNumber: null,
        state: 'CLOSED',
        closedAt: new Date(),
      },
      {
        sessionName: 'sessions/2',
        issueNumber: 999,
        pullRequestNumber: null,
        state: 'CLOSED',
        closedAt: new Date(),
      },
    ]
    const sessoesJson = sessoes.map((s) => ({
      ...s,
      closedAt: s.closedAt ? s.closedAt.toISOString() : null,
    }))
    const prisma = prismaFake(sessoes)

    await atualizarGrafoDeVinculos(
      depsBase({
        prisma: prisma as unknown as AtualizarGrafoDeps['prisma'],
        tipo: 'issue',
        numero: 580,
        repoItemId: 'item-issue-580',
      })
    )

    const gravado = prisma.linhas.get('item-issue-580') as Record<string, unknown>
    expect(gravado['sessoesJules']).toEqual([sessoesJson[0]])
  })

  it('tipo pr: sessoesJules inclui sessão já com pullRequestNumber igual E sessão achada só pelo sufixo do branch', async () => {
    const sessoes = [
      {
        sessionName: 'sessions/12112302527133030906',
        issueNumber: 100,
        pullRequestNumber: 583,
        state: 'MERGED',
        closedAt: new Date(),
      },
      {
        sessionName: 'sessions/16385381233224183643',
        issueNumber: 580,
        pullRequestNumber: null,
        state: 'CLOSED',
        closedAt: new Date(),
      },
      {
        sessionName: 'sessions/999999999999999999',
        issueNumber: 1,
        pullRequestNumber: null,
        state: 'CLOSED',
        closedAt: new Date(),
      },
    ]
    const sessoesJson = sessoes.map((s) => ({
      ...s,
      closedAt: s.closedAt ? s.closedAt.toISOString() : null,
    }))
    const prisma = prismaFake(sessoes)

    await atualizarGrafoDeVinculos(
      depsBase({
        prisma: prisma as unknown as AtualizarGrafoDeps['prisma'],
        tipo: 'pr',
        numero: 583,
        repoItemId: 'item-pr-583',
        headRefName: 'fix-tests-and-pipeline-check-16385381233224183643',
      })
    )

    const gravado = prisma.linhas.get('item-pr-583') as Record<string, unknown>
    expect(gravado['sessoesJules']).toEqual([sessoesJson[0], sessoesJson[1]])
  })

  it('idempotência: rodar 2x seguidas chama upsert 2 vezes mas grava sob o MESMO repoItemId (sem duplicar linha)', async () => {
    const prisma = prismaFake([])
    const deps = depsBase({
      prisma: prisma as unknown as AtualizarGrafoDeps['prisma'],
      repoItemId: 'item-idempotente',
    })

    await atualizarGrafoDeVinculos(deps)
    await atualizarGrafoDeVinculos(deps)

    expect(prisma.repoItemVinculos.upsert).toHaveBeenCalledTimes(2)
    expect(prisma.linhas.size).toBe(1)
    const chamadas = prisma.repoItemVinculos.upsert.mock.calls as Array<
      [{ where: { repoItemId: string } }]
    >
    expect(chamadas[0]?.[0].where.repoItemId).toBe('item-idempotente')
    expect(chamadas[1]?.[0].where.repoItemId).toBe('item-idempotente')
  })
})
