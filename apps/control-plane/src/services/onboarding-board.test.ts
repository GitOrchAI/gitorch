import { describe, it, expect, vi } from 'vitest'
import {
  ensureAndPersistProjectBoard,
  ensureProjectBoard,
  resolveGithubOwnerId,
} from './onboarding-board.js'

const cliente = (overrides: Record<string, unknown> = {}) => ({
  findProjectId: vi.fn(async () => null),
  createProjectV2: vi.fn(async () => ({ id: 'PVT_novo', number: 42 })),
  ...overrides,
})

// `findProjectId` real (packages/github-sync/src/project-v2-client.ts:220) pede
// `{ login, number, ownerType }`, não `{ owner, number }` — por isso
// `resolveOwner` devolve o tipo do dono junto do node id: sem ele não dá para
// montar a chamada certa a `findProjectId`.

describe('ensureProjectBoard', () => {
  it('cria o board quando não existe e devolve owner/number', async () => {
    const c = cliente()
    const r = await ensureProjectBoard({
      repository: 'GitOrchAI/gitorch',
      client: c as never,
      resolveOwner: async () => ({ id: 'O_org_gitorchai', type: 'organization' }),
    })
    expect(r).toEqual({ owner: 'GitOrchAI', number: 42 })
    expect(c.createProjectV2).toHaveBeenCalledWith({
      ownerId: 'O_org_gitorchai',
      title: 'GitOrchAI/gitorch',
    })
  })

  it('não duplica: se já existe board com o número conhecido, reaproveita', async () => {
    const c = cliente({ findProjectId: vi.fn(async () => 'PVT_existente') })
    const r = await ensureProjectBoard({
      repository: 'GitOrchAI/gitorch',
      client: c as never,
      resolveOwner: async () => ({ id: 'O_org_gitorchai', type: 'organization' }),
      existingNumber: 7,
    })
    expect(r).toEqual({ owner: 'GitOrchAI', number: 7 })
    expect(c.createProjectV2).not.toHaveBeenCalled()
    expect(c.findProjectId).toHaveBeenCalledWith({
      login: 'GitOrchAI',
      number: 7,
      ownerType: 'organization',
    })
  })

  it('devolve null sem lançar quando o token não pode criar board', async () => {
    const c = cliente({
      createProjectV2: vi.fn(async () => {
        throw new Error('Resource not accessible by integration')
      }),
    })
    const avisos: string[] = []
    const r = await ensureProjectBoard({
      repository: 'GitOrchAI/gitorch',
      client: c as never,
      resolveOwner: async () => ({ id: 'O_org_gitorchai', type: 'organization' }),
      onWarn: (m) => avisos.push(m),
    })
    expect(r).toBeNull()
    expect(avisos.join(' ')).toContain('board')
  })

  it('sem dono derivável do repositório, avisa e devolve null sem chamar a API', async () => {
    const c = cliente()
    const avisos: string[] = []
    const r = await ensureProjectBoard({
      repository: '',
      client: c as never,
      resolveOwner: async () => ({ id: 'x', type: 'user' }),
      onWarn: (m) => avisos.push(m),
    })
    expect(r).toBeNull()
    expect(c.createProjectV2).not.toHaveBeenCalled()
    expect(avisos.length).toBeGreaterThan(0)
  })
})

describe('resolveGithubOwnerId', () => {
  it('resolve dono do tipo usuário via GET /users/{owner}', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url))
      return {
        ok: true,
        status: 200,
        json: async () => ({ node_id: 'U_loureng', type: 'User' }),
      } as unknown as Response
    }) as unknown as typeof fetch

    const r = await resolveGithubOwnerId('loureng', 'tok', { fetchImpl })
    expect(r).toEqual({ id: 'U_loureng', type: 'user' })
    expect(calls).toEqual(['https://api.github.com/users/loureng'])
  })

  it('cai para GET /orgs/{owner} quando /users não acha', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url))
      if (String(url).includes('/users/')) {
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ node_id: 'O_gitorchai' }),
      } as unknown as Response
    }) as unknown as typeof fetch

    const r = await resolveGithubOwnerId('GitOrchAI', 'tok', { fetchImpl })
    expect(r).toEqual({ id: 'O_gitorchai', type: 'organization' })
    expect(calls).toEqual([
      'https://api.github.com/users/GitOrchAI',
      'https://api.github.com/orgs/GitOrchAI',
    ])
  })

  it('lança quando nem /users nem /orgs acham o dono', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    })) as unknown as typeof fetch
    await expect(resolveGithubOwnerId('fantasma', 'tok', { fetchImpl })).rejects.toThrow()
  })
})

// Visto em produção: no momento do registro do projeto o App ainda não estava
// instalado na organização, então criar o board falhou. Como o board só era
// tentado UMA vez (no provisionamento), o projeto ficava sem quadro para
// sempre — e sem quadro os trilhos do PO ficam desligados, ou seja, nenhuma
// issue jamais seria criada, mesmo depois de instalar o App. A esteira tem de
// se recuperar sozinha na próxima vez que o PO acorda.
describe('ensureAndPersistProjectBoard', () => {
  const projetoSemBoard = {
    id: 'proj_1',
    wingId: 'GitOrchAI/gitorch',
    runtimeConfig: { envConfig: { OUTRA_COISA: 'preservar' } },
  }

  it('projeto sem quadro: cria, grava em runtimeConfig preservando o resto e devolve owner/number', async () => {
    const update = vi.fn().mockResolvedValue({})
    const c = cliente()

    const r = await ensureAndPersistProjectBoard({
      project: projetoSemBoard,
      prisma: { project: { update } } as never,
      mintInstallationToken: async () => 'ghs_app',
      createProjectV2Client: () => c as never,
      resolveOwner: async () => ({ id: 'O_org', type: 'organization' }),
    })

    expect(r).toBe('GitOrchAI/42')
    expect(update).toHaveBeenCalledWith({
      where: { id: 'proj_1' },
      data: {
        runtimeConfig: {
          envConfig: { OUTRA_COISA: 'preservar', GITORCH_PROJECT_BOARD: 'GitOrchAI/42' },
        },
      },
    })
  })

  it('projeto que já tem quadro: devolve o gravado sem tocar no GitHub nem no banco', async () => {
    const update = vi.fn()
    const c = cliente()

    const r = await ensureAndPersistProjectBoard({
      project: {
        id: 'proj_2',
        wingId: 'GitOrchAI/gitorch',
        runtimeConfig: { envConfig: { GITORCH_PROJECT_BOARD: 'GitOrchAI/7' } },
      },
      prisma: { project: { update } } as never,
      mintInstallationToken: async () => 'ghs_app',
      createProjectV2Client: () => c as never,
      resolveOwner: async () => ({ id: 'O_org', type: 'organization' }),
    })

    expect(r).toBe('GitOrchAI/7')
    expect(c.createProjectV2).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('App ainda não instalado no dono do repositório: devolve undefined e avisa, sem gravar nada', async () => {
    const update = vi.fn()
    const avisos: string[] = []

    const r = await ensureAndPersistProjectBoard({
      project: projetoSemBoard,
      prisma: { project: { update } } as never,
      mintInstallationToken: async ({ onWarn }) => {
        onWarn?.('o GitHub App não está instalado em GitOrchAI')
        return null
      },
      createProjectV2Client: () => cliente() as never,
      resolveOwner: async () => ({ id: 'O_org', type: 'organization' }),
      onWarn: (m) => avisos.push(m),
    })

    expect(r).toBeUndefined()
    expect(update).not.toHaveBeenCalled()
    expect(avisos.join(' ')).toContain('não está instalado')
  })
})
