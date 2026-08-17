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

  it('quando a credencial do produto não cria o quadro, tenta com a do cliente', async () => {
    const clienteDoProduto = {
      findProjectId: vi.fn(async () => null),
      createProjectV2: vi.fn(async () => {
        throw new Error('does not have permission to create projects on ownerId U_x')
      }),
      linkProjectV2ToRepository: vi.fn(async () => 'R_repo'),
      descobrirQuadrosPorIssues: vi.fn(async () => []),
      detalharQuadro: vi.fn(async () => ({ camposCount: 0, outrosRepositorios: [] })),
    }
    const clienteDoCliente = {
      ...clienteDoProduto,
      createProjectV2: vi.fn(async () => ({ id: 'PVT_do_cliente', number: 77 })),
    }

    const r = await ensureProjectBoard({
      repository: 'dono/repo',
      client: clienteDoProduto as never,
      resolveOwner: async () => ({ id: 'U_dono', type: 'user' as const }),
      resolveRepositoryId: async () => 'R_repo',
      clientToken: 'tok-do-cliente',
      criarClienteAlternativo: () => clienteDoCliente as never,
    })

    expect(r).toEqual({ owner: 'dono', number: 77 })
    expect(clienteDoCliente.createProjectV2).toHaveBeenCalled()
  })

  it('sem credencial do cliente, a falha continua resolvendo em aviso acionável', async () => {
    const avisos: string[] = []
    const c = {
      findProjectId: vi.fn(async () => null),
      createProjectV2: vi.fn(async () => {
        throw new Error('does not have permission to create projects on ownerId U_x')
      }),
      linkProjectV2ToRepository: vi.fn(async () => 'R_repo'),
      descobrirQuadrosPorIssues: vi.fn(async () => []),
      detalharQuadro: vi.fn(async () => ({ camposCount: 0, outrosRepositorios: [] })),
    }
    const r = await ensureProjectBoard({
      repository: 'dono/repo',
      client: c as never,
      resolveOwner: async () => ({ id: 'U_dono', type: 'user' as const }),
      onWarn: (m) => avisos.push(m),
    })
    expect(r).toBeNull()
    expect(avisos.join(' ')).toContain('permission')
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
        json: async () => ({ node_id: 'U_dono_exemplo', type: 'User' }),
      } as unknown as Response
    }) as unknown as typeof fetch

    const r = await resolveGithubOwnerId('dono-exemplo', 'tok', { fetchImpl })
    expect(r).toEqual({ id: 'U_dono_exemplo', type: 'user' })
    expect(calls).toEqual(['https://api.github.com/users/dono-exemplo'])
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

  // `owner` chega de um valor que o cliente escolhe no funil (Project.wingId),
  // não de um literal do produto. A chamada carrega a credencial (token do App
  // ou do próprio cliente) no cabeçalho Authorization — se o valor pudesse
  // escapar do formato que o GitHub aceita, a URL montada sairia do GitHub e
  // levaria a credencial junto. Cada caso abaixo tem que ser recusado SEM
  // gerar nenhuma chamada de rede.
  describe('recusa owner fora do formato aceito pelo GitHub — nunca chama a rede', () => {
    const CASOS: Array<[string, string]> = [
      ['embute outro host com @', '@servidor-alheio'],
      ['string vazia', ''],
      ['caractere fora do conjunto permitido', 'dono!'],
      ['apenas ..', '..'],
    ]

    for (const [descricao, owner] of CASOS) {
      it(descricao, async () => {
        const fetchImpl = vi.fn() as unknown as typeof fetch
        await expect(resolveGithubOwnerId(owner, 'tok', { fetchImpl })).rejects.toThrow()
        expect(fetchImpl).not.toHaveBeenCalled()
      })
    }
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

  // Mesmo risco de `resolveGithubOwnerId` acima, mas aqui `repository` monta a
  // URL inteira (`/repos/{repository}`) — a superfície é maior: travessia de
  // diretório, host embutido, query string injetada. Cada caso tem que ser
  // recusado SEM gerar nenhuma chamada de rede.
  describe('recusa repository fora do formato dono/repo — nunca chama a rede', () => {
    const CASOS: Array<[string, string]> = [
      ['atravessa diretório com ../', 'dono/repo/../../outro'],
      ['embute outro host com @', '@servidor-alheio/caminho'],
      ['injeta query string', 'dono/repo?x=y'],
      ['string vazia', ''],
      ['barra a mais no caminho', 'dono/repo/extra'],
      ['caractere fora do conjunto permitido', 'dono/repo!'],
    ]

    for (const [descricao, repository] of CASOS) {
      it(descricao, async () => {
        const fetchImpl = vi.fn() as unknown as typeof fetch
        await expect(resolveGithubRepositoryId(repository, 'tok', { fetchImpl })).rejects.toThrow()
        expect(fetchImpl).not.toHaveBeenCalled()
      })
    }
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

  it('credencial do cliente lida com sucesso: chega como clientToken e viabiliza a segunda tentativa', async () => {
    const clienteDoProduto = cliente({
      createProjectV2: vi.fn(async () => {
        throw new Error('does not have permission to create projects on ownerId U_x')
      }),
    })
    const clienteDoCliente = cliente({
      createProjectV2: vi.fn(async () => ({ id: 'PVT_cliente', number: 77 })),
    })
    const update = vi.fn().mockResolvedValue({})

    const r = await ensureAndPersistProjectBoard({
      project: { id: 'proj_5', wingId: 'dono/repo', runtimeConfig: null },
      prisma: { project: { update } } as never,
      mintInstallationToken: async () => 'ghs_app',
      createProjectV2Client: () => clienteDoProduto as never,
      resolveOwner: async () => ({ id: 'U_dono', type: 'user' as const }),
      lerClientToken: async () => 'tok-do-cliente',
      criarClienteAlternativo: (token) => {
        expect(token).toBe('tok-do-cliente')
        return clienteDoCliente as never
      },
    })

    expect(r).toBe('dono/77')
    expect(clienteDoCliente.createProjectV2).toHaveBeenCalled()
  })

  it('leitura da credencial do cliente lança: engolida, o quadro segue sendo tentado sem ela', async () => {
    const c = cliente()
    const update = vi.fn().mockResolvedValue({})
    const avisos: string[] = []
    const criarClienteAlternativo = vi.fn()

    const r = await ensureAndPersistProjectBoard({
      project: { id: 'proj_6', wingId: 'dono/repo', runtimeConfig: null },
      prisma: { project: { update } } as never,
      mintInstallationToken: async () => 'ghs_app',
      createProjectV2Client: () => c as never,
      resolveOwner: async () => ({ id: 'U_dono', type: 'user' as const }),
      lerClientToken: async () => {
        throw new Error('chave de cifragem rotacionada')
      },
      criarClienteAlternativo,
      onWarn: (m) => avisos.push(m),
    })

    expect(r).toBe('dono/42')
    expect(criarClienteAlternativo).not.toHaveBeenCalled()
    expect(avisos.join(' ')).toContain('credencial do cliente')
  })
})

// A árvore que a esteira percorre antes de criar qualquer coisa.
//
// A descoberta é por EVIDÊNCIA, não por semelhança de nome: o quadro deste
// repositório é aquele onde as issues dele já estão. Casar por título foi
// tentado e reprovado — a comparação normalizava separadores e acabou adotando
// o quadro de um repositório para outro sem relação nenhuma. Uma issue dentro
// de um quadro é fato; nome parecido é palpite.
describe('ensureProjectBoard — descobre por evidência antes de criar', () => {
  const clienteCompleto = (over: Record<string, unknown> = {}) => ({
    findProjectId: vi.fn(async () => null),
    createProjectV2: vi.fn(async () => ({ id: 'PVT_novo', number: 42 })),
    linkProjectV2ToRepository: vi.fn(async () => 'R_repo'),
    listarQuadrosDoRepositorio: vi.fn(async () => []),
    descobrirQuadrosPorIssues: vi.fn(async () => []),
    detalharQuadro: vi.fn(async () => ({ camposCount: 14, outrosRepositorios: [] })),
    ...over,
  })

  const base = {
    repository: 'dono/repo',
    resolveOwner: async () => ({ id: 'U_dono', type: 'user' as const }),
    resolveRepositoryId: async () => 'R_repo',
  }

  it('1) já ligado ao repositório: coleta o número e não cria nem liga nada', async () => {
    const c = clienteCompleto({
      listarQuadrosDoRepositorio: vi.fn(async () => [{ id: 'PVT_ja', number: 7, title: 'x' }]),
    })
    const r = await ensureProjectBoard({ ...base, client: c as never })
    expect(r).toEqual({ owner: 'dono', number: 7 })
    expect(c.createProjectV2).not.toHaveBeenCalled()
    expect(c.linkProjectV2ToRepository).not.toHaveBeenCalled()
  })

  it('2) issues do repositório apontam um quadro solto: liga esse quadro', async () => {
    const c = clienteCompleto({
      descobrirQuadrosPorIssues: vi.fn(async () => [
        { id: 'PVT_achado', number: 9, title: 'qualquer nome', closed: false, issuesDesteRepo: 48 },
      ]),
    })
    const r = await ensureProjectBoard({ ...base, client: c as never })
    expect(r).toEqual({ owner: 'dono', number: 9 })
    expect(c.createProjectV2).not.toHaveBeenCalled()
    expect(c.linkProjectV2ToRepository).toHaveBeenCalledWith({
      projectId: 'PVT_achado',
      repositoryId: 'R_repo',
    })
  })

  // Decisão do dono: vence o quadro com MAIS CAMPOS. Respeita quem investiu
  // trabalho no quadro à mão, em vez de preferir o mais novo — que costuma ser
  // justamente o que o próprio produto criou, e o mais pobre.
  it('havendo mais de um candidato, vence o quadro mais rico em campos', async () => {
    const c = clienteCompleto({
      descobrirQuadrosPorIssues: vi.fn(async () => [
        { id: 'PVT_pobre', number: 9, title: 'novo', closed: false, issuesDesteRepo: 78 },
        { id: 'PVT_rico', number: 3, title: 'antigo', closed: false, issuesDesteRepo: 48 },
      ]),
      detalharQuadro: vi.fn(async ({ projectId }: { projectId: string }) =>
        projectId === 'PVT_rico'
          ? { camposCount: 23, outrosRepositorios: [] }
          : { camposCount: 14, outrosRepositorios: [] }
      ),
    })
    const r = await ensureProjectBoard({ ...base, client: c as never })
    expect(r).toEqual({ owner: 'dono', number: 3 })
    expect(c.linkProjectV2ToRepository).toHaveBeenCalledWith({
      projectId: 'PVT_rico',
      repositoryId: 'R_repo',
    })
  })

  // Quadro que guarda trabalho de outros repositórios é casa dos outros:
  // despejar o backlog deste projeto lá dentro seria invadir.
  it('quadro compartilhado com outro repositório não é adotado', async () => {
    const c = clienteCompleto({
      descobrirQuadrosPorIssues: vi.fn(async () => [
        { id: 'PVT_comum', number: 7, title: 'roadmap geral', closed: false, issuesDesteRepo: 3 },
      ]),
      detalharQuadro: vi.fn(async () => ({
        camposCount: 30,
        outrosRepositorios: ['outro/alheio'],
      })),
    })
    const r = await ensureProjectBoard({ ...base, client: c as never })
    expect(r).toEqual({ owner: 'dono', number: 42 })
    expect(c.createProjectV2).toHaveBeenCalled()
  })

  it('quadro fechado não é adotado', async () => {
    const c = clienteCompleto({
      descobrirQuadrosPorIssues: vi.fn(async () => [
        { id: 'PVT_morto', number: 4, title: 'arquivado', closed: true, issuesDesteRepo: 10 },
      ]),
    })
    const r = await ensureProjectBoard({ ...base, client: c as never })
    expect(r).toEqual({ owner: 'dono', number: 42 })
    expect(c.createProjectV2).toHaveBeenCalled()
  })

  it('3) nada existe: cria e liga', async () => {
    const c = clienteCompleto()
    const r = await ensureProjectBoard({ ...base, client: c as never })
    expect(r).toEqual({ owner: 'dono', number: 42 })
    expect(c.createProjectV2).toHaveBeenCalled()
    expect(c.linkProjectV2ToRepository).toHaveBeenCalledWith({
      projectId: 'PVT_novo',
      repositoryId: 'R_repo',
    })
  })

  it('não conseguir criar resolve em aviso acionável, nunca em silêncio', async () => {
    const avisos: string[] = []
    const c = clienteCompleto({
      createProjectV2: vi.fn(async () => {
        throw new Error('does not have permission to create projects on ownerId U_x')
      }),
    })
    const r = await ensureProjectBoard({
      ...base,
      client: c as never,
      onWarn: (m) => avisos.push(m),
    })
    expect(r).toBeNull()
    expect(avisos.join(' ')).toContain('dono/repo')
    expect(avisos.join(' ')).toContain('permission')
  })

  it('cliente sem as consultas de descoberta continua criando como antes', async () => {
    const c = {
      findProjectId: vi.fn(async () => null),
      createProjectV2: vi.fn(async () => ({ id: 'PVT_novo', number: 42 })),
      linkProjectV2ToRepository: vi.fn(async () => 'R_repo'),
    }
    const r = await ensureProjectBoard({ ...base, client: c as never })
    expect(r).toEqual({ owner: 'dono', number: 42 })
  })
})

// Achado de revisão: o tipo permite um cliente que descobre quadros mas não
// sabe olhar dentro deles. Nesse caso não há como afirmar exclusividade, e
// adotar assim mesmo reabriria o risco de despejar o backlog na casa de outro.
describe('ensureProjectBoard — sem poder verificar exclusividade', () => {
  it('não adota candidato quando o cliente não sabe detalhar o quadro', async () => {
    const c = {
      findProjectId: vi.fn(async () => null),
      createProjectV2: vi.fn(async () => ({ id: 'PVT_novo', number: 42 })),
      linkProjectV2ToRepository: vi.fn(async () => 'R_repo'),
      descobrirQuadrosPorIssues: vi.fn(async () => [
        { id: 'PVT_x', number: 5, title: 'algum', closed: false, issuesDesteRepo: 3 },
      ]),
      // repare: sem detalharQuadro
    }
    const r = await ensureProjectBoard({
      repository: 'dono/repo',
      client: c as never,
      resolveOwner: async () => ({ id: 'U_dono', type: 'user' as const }),
      resolveRepositoryId: async () => 'R_repo',
    })
    expect(r).toEqual({ owner: 'dono', number: 42 })
    expect(c.createProjectV2).toHaveBeenCalled()
  })
})

describe('teto de tempo (leva D)', () => {
  it('resolveGithubOwnerId: a chamada carrega um AbortSignal não abortado', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ node_id: 'U_dono', type: 'User' }),
    }))
    await resolveGithubOwnerId('dono-exemplo', 'tok', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(0)
    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit | undefined
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(init?.signal?.aborted).toBe(false)
    }
  })

  it('resolveGithubRepositoryId: a chamada carrega um AbortSignal não abortado', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ node_id: 'R_gitorch' }),
    }))
    await resolveGithubRepositoryId('GitOrchAI/gitorch', 'tok', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(0)
    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit | undefined
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(init?.signal?.aborted).toBe(false)
    }
  })
})
