import { describe, it, expect, vi } from 'vitest'
import {
  ensureAndPersistProjectBoard,
  ensureProjectBoard,
  resolveGithubOwnerId,
  resolveGithubRepositoryId,
} from './onboarding-board.js'

const cliente = (overrides: Record<string, unknown> = {}) => ({
  findProjectId: vi.fn(async () => null),
  createProjectV2: vi.fn(async () => ({ id: 'PVT_novo', number: 42 })),
  linkProjectV2ToRepository: vi.fn(async () => 'R_repo'),
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

  // Achado em produção (medido via API do próprio GitHub): o board era criado
  // pendurado no dono (organization.projectsV2 o via), mas nunca anunciado ao
  // repositório (repository.projectsV2.totalCount ficava em 0 — não aparecia
  // na aba /projects do repositório). `linkProjectV2ToRepository` é chamada
  // logo após `createProjectV2`, só no caminho de CRIAÇÃO.
  it('quadro recém-criado é ligado ao repositório quando resolveRepositoryId é fornecido', async () => {
    const c = cliente()
    const r = await ensureProjectBoard({
      repository: 'GitOrchAI/gitorch',
      client: c as never,
      resolveOwner: async () => ({ id: 'O_org_gitorchai', type: 'organization' }),
      resolveRepositoryId: async () => 'R_gitorch',
    })
    expect(r).toEqual({ owner: 'GitOrchAI', number: 42 })
    expect(c.linkProjectV2ToRepository).toHaveBeenCalledWith({
      projectId: 'PVT_novo',
      repositoryId: 'R_gitorch',
    })
  })

  it('board REAPROVEITADO (existingNumber) não tenta ligar de novo', async () => {
    const c = cliente({ findProjectId: vi.fn(async () => 'PVT_existente') })
    const r = await ensureProjectBoard({
      repository: 'GitOrchAI/gitorch',
      client: c as never,
      resolveOwner: async () => ({ id: 'O_org_gitorchai', type: 'organization' }),
      resolveRepositoryId: async () => 'R_gitorch',
      existingNumber: 7,
    })
    expect(r).toEqual({ owner: 'GitOrchAI', number: 7 })
    expect(c.linkProjectV2ToRepository).not.toHaveBeenCalled()
  })

  it('sem resolveRepositoryId configurado, cria o board normalmente sem tentar ligar', async () => {
    const c = cliente()
    const r = await ensureProjectBoard({
      repository: 'GitOrchAI/gitorch',
      client: c as never,
      resolveOwner: async () => ({ id: 'O_org_gitorchai', type: 'organization' }),
    })
    expect(r).toEqual({ owner: 'GitOrchAI', number: 42 })
    expect(c.linkProjectV2ToRepository).not.toHaveBeenCalled()
  })

  it('falha ao ligar o quadro ao repositório NÃO derruba a criação (aviso, board criado normalmente)', async () => {
    const c = cliente({
      linkProjectV2ToRepository: vi.fn(async () => {
        throw new Error('Resource not accessible by integration')
      }),
    })
    const avisos: string[] = []
    const r = await ensureProjectBoard({
      repository: 'GitOrchAI/gitorch',
      client: c as never,
      resolveOwner: async () => ({ id: 'O_org_gitorchai', type: 'organization' }),
      resolveRepositoryId: async () => 'R_gitorch',
      onWarn: (m) => avisos.push(m),
    })
    expect(r).toEqual({ owner: 'GitOrchAI', number: 42 })
    expect(avisos.join(' ')).toContain('ligar')
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

describe('resolveGithubRepositoryId', () => {
  it('resolve o node id do repositório via GET /repos/{owner}/{repo}', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url))
      return {
        ok: true,
        status: 200,
        json: async () => ({ node_id: 'R_gitorch' }),
      } as unknown as Response
    }) as unknown as typeof fetch

    const id = await resolveGithubRepositoryId('GitOrchAI/gitorch', 'tok', { fetchImpl })
    expect(id).toBe('R_gitorch')
    expect(calls).toEqual(['https://api.github.com/repos/GitOrchAI/gitorch'])
  })

  it('lança quando o repositório não é encontrado', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    })) as unknown as typeof fetch
    await expect(
      resolveGithubRepositoryId('GitOrchAI/fantasma', 'tok', { fetchImpl })
    ).rejects.toThrow()
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

// A árvore de decisão que a esteira precisa percorrer antes de criar qualquer
// coisa. Sem ela, um cliente que já mantém o quadro do próprio projeto vê o
// produto ignorar o quadro dele e abrir outro por cima — foi o que aconteceu
// num repositório que já tinha dois.
describe('ensureProjectBoard — descobre antes de criar', () => {
  const clienteCompleto = (over: Record<string, unknown> = {}) => ({
    findProjectId: vi.fn(async () => null),
    createProjectV2: vi.fn(async () => ({ id: 'PVT_novo', number: 42 })),
    linkProjectV2ToRepository: vi.fn(async () => 'R_repo'),
    listarQuadrosDoRepositorio: vi.fn(async () => []),
    listarQuadrosDaConta: vi.fn(async () => []),
    ...over,
  })

  it('1) já ligado ao repositório: coleta o número e não cria nada', async () => {
    const c = clienteCompleto({
      listarQuadrosDoRepositorio: vi.fn(async () => [
        { id: 'PVT_ja', number: 7, title: 'dono/repo' },
      ]),
    })
    const r = await ensureProjectBoard({
      repository: 'dono/repo',
      client: c as never,
      resolveOwner: async () => ({ id: 'U_dono', type: 'user' }),
    })
    expect(r).toEqual({ owner: 'dono', number: 7 })
    expect(c.createProjectV2).not.toHaveBeenCalled()
    expect(c.linkProjectV2ToRepository).not.toHaveBeenCalled()
  })

  it('2) existe na conta um quadro deste repositório, mas solto: liga em vez de criar', async () => {
    const c = clienteCompleto({
      listarQuadrosDoRepositorio: vi.fn(async () => []),
      listarQuadrosDaConta: vi.fn(async () => [
        { id: 'PVT_outro', number: 3, title: 'Coisa sem relação' },
        { id: 'PVT_certo', number: 9, title: 'dono/repo' },
      ]),
    })
    const r = await ensureProjectBoard({
      repository: 'dono/repo',
      client: c as never,
      resolveOwner: async () => ({ id: 'U_dono', type: 'user' }),
      resolveRepositoryId: async () => 'R_repo',
    })
    expect(r).toEqual({ owner: 'dono', number: 9 })
    expect(c.createProjectV2).not.toHaveBeenCalled()
    expect(c.linkProjectV2ToRepository).toHaveBeenCalledWith({
      projectId: 'PVT_certo',
      repositoryId: 'R_repo',
    })
  })

  it('reconhece o quadro pelo nome do repositório, não só pelo caminho completo', async () => {
    const c = clienteCompleto({
      listarQuadrosDaConta: vi.fn(async () => [
        { id: 'PVT_x', number: 4, title: 'Jardim das Patinhas' },
      ]),
    })
    const r = await ensureProjectBoard({
      repository: 'loureng/jardim-das-patinhas',
      client: c as never,
      resolveOwner: async () => ({ id: 'U_l', type: 'user' }),
      resolveRepositoryId: async () => 'R_j',
    })
    expect(r).toEqual({ owner: 'loureng', number: 4 })
    expect(c.createProjectV2).not.toHaveBeenCalled()
  })

  it('quadro da conta que NÃO é deste repositório não é sequestrado', async () => {
    const c = clienteCompleto({
      listarQuadrosDaConta: vi.fn(async () => [
        { id: 'PVT_alheio', number: 5, title: 'Outro projeto qualquer' },
      ]),
    })
    const r = await ensureProjectBoard({
      repository: 'dono/repo',
      client: c as never,
      resolveOwner: async () => ({ id: 'U_dono', type: 'user' }),
    })
    expect(r).toEqual({ owner: 'dono', number: 42 })
    expect(c.createProjectV2).toHaveBeenCalled()
  })

  it('3) nada existe: cria e liga', async () => {
    const c = clienteCompleto()
    const r = await ensureProjectBoard({
      repository: 'dono/repo',
      client: c as never,
      resolveOwner: async () => ({ id: 'U_dono', type: 'user' }),
      resolveRepositoryId: async () => 'R_repo',
    })
    expect(r).toEqual({ owner: 'dono', number: 42 })
    expect(c.createProjectV2).toHaveBeenCalled()
    expect(c.linkProjectV2ToRepository).toHaveBeenCalledWith({
      projectId: 'PVT_novo',
      repositoryId: 'R_repo',
    })
  })

  // Conta pessoal: a credencial do App não enxerga nem cria quadro. O aviso
  // precisa dizer o que aconteceu — sem quadro a esteira segue, mas quem lê o
  // log tem que saber por quê.
  it('não conseguir criar resolve em aviso acionável, nunca em silêncio', async () => {
    const avisos: string[] = []
    const c = clienteCompleto({
      createProjectV2: vi.fn(async () => {
        throw new Error('does not have permission to create projects on ownerId U_x')
      }),
    })
    const r = await ensureProjectBoard({
      repository: 'dono/repo',
      client: c as never,
      resolveOwner: async () => ({ id: 'U_dono', type: 'user' }),
      onWarn: (m) => avisos.push(m),
    })
    expect(r).toBeNull()
    expect(avisos.join(' ')).toContain('dono/repo')
    expect(avisos.join(' ')).toContain('permission')
  })

  // Cliente antigo, sem os métodos de descoberta, não pode quebrar.
  it('cliente sem as consultas de descoberta continua criando como antes', async () => {
    const c = {
      findProjectId: vi.fn(async () => null),
      createProjectV2: vi.fn(async () => ({ id: 'PVT_novo', number: 42 })),
      linkProjectV2ToRepository: vi.fn(async () => 'R_repo'),
    }
    const r = await ensureProjectBoard({
      repository: 'dono/repo',
      client: c as never,
      resolveOwner: async () => ({ id: 'U_dono', type: 'user' }),
    })
    expect(r).toEqual({ owner: 'dono', number: 42 })
  })
})
