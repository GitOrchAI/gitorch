import { describe, it, expect, vi, beforeEach } from 'vitest'
import { aplicarRetratoInicial } from './aplicar-retrato-inicial.js'

function ghGetFake(rotas: Record<string, unknown>) {
  return vi.fn(async (caminho: string, options?: RequestInit) => {
    // For GraphQL
    if (caminho === '/graphql') {
      const body = JSON.parse(typeof options?.body === 'string' ? options.body : '{}')
      const variables = body.variables || {}

      const key = `graphql-${variables.prNumber}`
      if (rotas[key]) return rotas[key]

      return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } } }
    }

    for (const [padrao, resposta] of Object.entries(rotas)) {
      if (caminho.startsWith(padrao)) return resposta
    }
    throw new Error(`rota não mapeada no teste: ${caminho}`)
  })
}

describe('aplicarRetratoInicial', () => {
  let devSessionData: Array<{
    pullRequestNumber: number | null
    issueNumber: number
    closedAt: Date | null
    sessionName: string
  }> = []
  let eventData: Array<{ type: string; payload: Record<string, string> }> = []
  let fichaData: Array<{
    projectId_tipo_numero: { projectId: string; tipo: string; numero: number }
    estado?: Record<string, unknown>
    origem?: string
  }> = []

  const prismaMock = {
    project: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: 'proj-1', runtimeConfig: {}, devAccountId: 'dev-1' }),
    },
    devSession: {
      findMany: vi.fn(async ({ where }) =>
        devSessionData.filter((s) => s.pullRequestNumber === where.pullRequestNumber)
      ),
      count: vi.fn().mockResolvedValue(0),
    },
    event: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(async ({ data }) => {
        eventData.push(data)
      }),
    },
    fichaDoItem: {
      findUnique: vi.fn(async ({ where }) => {
        return (
          fichaData.find(
            (f: {
              projectId_tipo_numero: { projectId: string; tipo: string; numero: number }
              estado?: Record<string, unknown>
              origem?: string
            }) =>
              f.projectId_tipo_numero.projectId === where.projectId_tipo_numero.projectId &&
              f.projectId_tipo_numero.tipo === where.projectId_tipo_numero.tipo &&
              f.projectId_tipo_numero.numero === where.projectId_tipo_numero.numero
          ) || null
        )
      }),
      upsert: vi.fn(async ({ create, update, where }) => {
        const idx = fichaData.findIndex(
          (f: {
            projectId_tipo_numero: { projectId: string; tipo: string; numero: number }
            estado?: Record<string, unknown>
            origem?: string
          }) =>
            f.projectId_tipo_numero.projectId === where.projectId_tipo_numero.projectId &&
            f.projectId_tipo_numero.tipo === where.projectId_tipo_numero.tipo &&
            f.projectId_tipo_numero.numero === where.projectId_tipo_numero.numero
        )
        if (idx >= 0) {
          fichaData[idx] = { ...fichaData[idx], ...update }
        } else {
          fichaData.push({ projectId_tipo_numero: where.projectId_tipo_numero, ...create })
        }
      }),
    },
    $disconnect: vi.fn(),
  } as never

  beforeEach(() => {
    devSessionData = []
    eventData = []
    fichaData = []
    vi.clearAllMocks()
  })

  it('vincula tarefa via GraphQL (closingIssuesReferences) e etiqueta de delegação', async () => {
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?state=open': [{ number: 1, body: 'nada' }],
      'graphql-1': {
        data: {
          repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 100 }] } } },
        },
      },
      '/repos/dono/repo/issues/100': { labels: ['gitorch:task'] },
      '/repos/dono/repo/pulls/1/commits': [
        { commit: { message: 'feat: add stuff' }, author: { login: 'humano' } },
      ],
      '/repos/dono/repo/pulls/1': {
        mergeable: true,
        updated_at: '2026-08-01T00:00:00Z',
        changed_files: 1,
      },
    })

    await aplicarRetratoInicial({
      prisma: prismaMock,
      ghGet,
      REPOSITORY: 'dono/repo',
      PROJECT_ID: 'proj-1',
    })

    // Check if event was created specifying action because the origin was classified
    const auditEvent = eventData.find(
      (e) => e.type === 'audit' && (e.payload['texto'] as string).includes('#1: ação decidida')
    )
    expect(auditEvent).toBeDefined()

    // Check ficha
    const ficha = fichaData.find(
      (f: {
        projectId_tipo_numero: { projectId: string; tipo: string; numero: number }
        estado?: Record<string, unknown>
        origem?: string
      }) => f.projectId_tipo_numero.numero === 1 && f.projectId_tipo_numero.tipo === 'pr'
    )
    expect(ficha!).toBeDefined()
    expect(ficha!.origem).toBe('desconhecido') // Not dev, no session, but processed
  })

  it('vincula tarefa via corpo do PR (closes #N) e etiqueta', async () => {
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?state=open': [{ number: 2, body: 'fixes #200' }],
      'graphql-2': {
        data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } },
      },
      '/repos/dono/repo/issues/200': { labels: [{ name: 'gitorch:task' }] },
      '/repos/dono/repo/pulls/2/commits': [
        { commit: { message: 'fix: whatever' }, author: { login: 'jules' } },
      ],
      '/repos/dono/repo/pulls/2': {
        mergeable: true,
        updated_at: '2026-08-01T00:00:00Z',
        changed_files: 1,
      },
    })

    // Simular que existiu sessão para essa issue, que é requerido para o vínculo por corpo funcionar
    devSessionData.push({
      pullRequestNumber: 2,
      issueNumber: 200,
      closedAt: new Date(),
      sessionName: 'sess',
    })

    await aplicarRetratoInicial({
      prisma: prismaMock,
      ghGet,
      REPOSITORY: 'dono/repo',
      PROJECT_ID: 'proj-1',
    })

    const ficha = fichaData.find(
      (f: {
        projectId_tipo_numero: { projectId: string; tipo: string; numero: number }
        estado?: Record<string, unknown>
        origem?: string
      }) => f.projectId_tipo_numero.numero === 2 && f.projectId_tipo_numero.tipo === 'pr'
    )
    expect(ficha!.origem).toBe('jules_gitorch')
  })

  it('vincula tarefa via branch do jules', async () => {
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?state=open': [
        { number: 3, head: { ref: 'jules-1234567890123456-abc' } },
      ],
      'graphql-3': {
        data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } },
      },
      '/repos/dono/repo/pulls/3/commits': [
        { commit: { message: 'fix' }, author: { login: 'jules' } },
      ],
      '/repos/dono/repo/pulls/3': {
        mergeable: true,
        updated_at: '2026-08-01T00:00:00Z',
        changed_files: 1,
      },
    })

    // Casamento requer sessão com nome igual a 'sessions/1234567890123456'
    devSessionData.push({
      pullRequestNumber: null,
      issueNumber: 300,
      closedAt: new Date(),
      sessionName: 'sessions/1234567890123456',
    })

    await aplicarRetratoInicial({
      prisma: prismaMock,
      ghGet,
      REPOSITORY: 'dono/repo',
      PROJECT_ID: 'proj-1',
    })

    const ficha = fichaData.find(
      (f: {
        projectId_tipo_numero: { projectId: string; tipo: string; numero: number }
        estado?: Record<string, unknown>
        origem?: string
      }) => f.projectId_tipo_numero.numero === 3 && f.projectId_tipo_numero.tipo === 'pr'
    )
    expect(ficha!.origem).toBe('jules_gitorch')
  })

  it('não vincula se não tiver link', async () => {
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?state=open': [{ number: 4, body: 'random pr' }],
      'graphql-4': {
        data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } },
      },
      '/repos/dono/repo/pulls/4/commits': [
        { commit: { message: 'feat' }, author: { login: 'humano' } },
      ],
      '/repos/dono/repo/pulls/4': {
        mergeable: true,
        updated_at: '2026-08-01T00:00:00Z',
        changed_files: 1,
      },
    })

    await aplicarRetratoInicial({
      prisma: prismaMock,
      ghGet,
      REPOSITORY: 'dono/repo',
      PROJECT_ID: 'proj-1',
    })
    const ficha = fichaData.find(
      (f: {
        projectId_tipo_numero: { projectId: string; tipo: string; numero: number }
        estado?: Record<string, unknown>
        origem?: string
      }) => f.projectId_tipo_numero.numero === 4 && f.projectId_tipo_numero.tipo === 'pr'
    )
    expect(ficha!.origem).toBe('desconhecido')
  })

  it('preserva campos existentes da ficha do banco (conflict, draft) ao aplicar', async () => {
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?state=open': [{ number: 5, draft: false }],
      'graphql-5': {
        data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } },
      },
      '/repos/dono/repo/pulls/5/commits': [
        { commit: { message: 'feat' }, author: { login: 'humano' } },
      ],
      '/repos/dono/repo/pulls/5': {
        mergeable: true,
        updated_at: '2026-08-01T00:00:00Z',
        changed_files: 1,
      },
    })

    // Pré-popula a ficha com estado detalhado
    fichaData.push({
      projectId_tipo_numero: { projectId: 'proj-1', tipo: 'pr', numero: 5 },
      estado: {
        status: 'draft',
        conflito: true,
        ultimoCommitEm: '2026-01-01',
        arquivosMexidos: 10,
      },
      origem: 'desconhecido',
    })

    await aplicarRetratoInicial({
      prisma: prismaMock,
      ghGet,
      REPOSITORY: 'dono/repo',
      PROJECT_ID: 'proj-1',
    })

    const ficha = fichaData.find(
      (f: {
        projectId_tipo_numero: { projectId: string; tipo: string; numero: number }
        estado?: Record<string, unknown>
        origem?: string
      }) => f.projectId_tipo_numero.numero === 5 && f.projectId_tipo_numero.tipo === 'pr'
    )
    // Status atualiza para 'open' (ou sobrescrito pelo fetch inicial), MAS conflito/ultimoCommitEm devem ser preservados
    expect(ficha!.estado!['conflito']).toBe(true)
    expect(ficha!.estado!['ultimoCommitEm']).toBe('2026-01-01')
    expect(ficha!.estado!['arquivosMexidos']).toBe(10)
  })

  it('é idempotente (rodar duas vezes não duplica/sobrescreve campos com null)', async () => {
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?state=open': [{ number: 6 }],
      'graphql-6': {
        data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } },
      },
      '/repos/dono/repo/pulls/6/commits': [
        { commit: { message: 'feat' }, author: { login: 'humano' } },
      ],
      '/repos/dono/repo/pulls/6': {
        mergeable: true,
        updated_at: '2026-08-01T00:00:00Z',
        changed_files: 1,
      },
    })

    await aplicarRetratoInicial({
      prisma: prismaMock,
      ghGet,
      REPOSITORY: 'dono/repo',
      PROJECT_ID: 'proj-1',
    })
    const stateAfterFirst = JSON.stringify(fichaData)

    await aplicarRetratoInicial({
      prisma: prismaMock,
      ghGet,
      REPOSITORY: 'dono/repo',
      PROJECT_ID: 'proj-1',
    })
    const stateAfterSecond = JSON.stringify(fichaData)

    expect(stateAfterSecond).toEqual(stateAfterFirst)
  })
})
