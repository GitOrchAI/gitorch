import { describe, expect, test, vi } from 'vitest'
import {
  provisionSetupMission,
  selectClaimableSetupMissions,
  type RuntimeStack,
} from './scheduler.js'

function fakeStack(allocateWorkspace: ReturnType<typeof vi.fn>): RuntimeStack {
  return {
    // registry/orchestrator não são usados por provisionSetupMission — só o
    // workspaceProvider clona o repo. Double mínimo, mesma disciplina dos
    // outros testes desta sessão.
    registry: {} as RuntimeStack['registry'],
    orchestrator: {} as RuntimeStack['orchestrator'],
    workspaceProvider: {
      allocateWorkspace,
      hibernateWorkspace: vi.fn(),
    } as unknown as RuntimeStack['workspaceProvider'],
  }
}

describe('provisionSetupMission', () => {
  test('aloca o workspace do projeto e retorna completed em sucesso', async () => {
    const allocateWorkspace = vi.fn().mockResolvedValue({ path: '/workspace/x' })
    const stack = fakeStack(allocateWorkspace)

    const outcome = await provisionSetupMission(
      {
        id: 'mission_1',
        project: { id: 'proj_1', wingId: 'octocat/repo', userId: 'user_1' },
      },
      stack
    )

    expect(outcome.status).toBe('completed')
    expect(allocateWorkspace).toHaveBeenCalledWith('user_1', 'proj_1', {
      repository: 'octocat/repo',
    })
  })

  test('sem userId, usa o usuário genérico do scheduler (mesma convenção do dispatch clássico)', async () => {
    const allocateWorkspace = vi.fn().mockResolvedValue({ path: '/workspace/x' })
    const stack = fakeStack(allocateWorkspace)

    await provisionSetupMission(
      { id: 'mission_2', project: { id: 'proj_2', wingId: 'octocat/repo2', userId: null } },
      stack
    )

    expect(allocateWorkspace).toHaveBeenCalledWith('scheduler-user', 'proj_2', {
      repository: 'octocat/repo2',
    })
  })

  test('repassa o token do GitHub do dono do projeto para clonar repo privado', async () => {
    const allocateWorkspace = vi.fn().mockResolvedValue({ path: '/workspace/x' })
    const stack = fakeStack(allocateWorkspace)

    await provisionSetupMission(
      { id: 'mission_4', project: { id: 'proj_4', wingId: 'octocat/private', userId: 'user_1' } },
      stack,
      'gh_owner_token'
    )

    expect(allocateWorkspace).toHaveBeenCalledWith('user_1', 'proj_4', {
      repository: 'octocat/private',
      token: 'gh_owner_token',
    })
  })

  test('retorna failed com a causa real quando o clone falha (nunca mascara)', async () => {
    const allocateWorkspace = vi.fn().mockRejectedValue(new Error('workspace remoto falhou'))
    const stack = fakeStack(allocateWorkspace)

    const outcome = await provisionSetupMission(
      { id: 'mission_3', project: { id: 'proj_3', wingId: 'octocat/repo3', userId: 'user_1' } },
      stack
    )

    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('workspace remoto falhou')
  })

  // Task 9: projeto novo ganha a PRÓPRIA mesa de trabalho no setup — sem
  // prisma (deps antigas/testes de clone acima) o passo é pulado por
  // completo, então esses 4 testes continuam verdes sem tocar rede nenhuma.
  test('com token e prisma, cria o board e grava GITORCH_PROJECT_BOARD no runtimeConfig do projeto', async () => {
    const allocateWorkspace = vi.fn().mockResolvedValue({ path: '/workspace/x' })
    const stack = fakeStack(allocateWorkspace)
    const update = vi.fn().mockResolvedValue({})
    const findProjectId = vi.fn(async () => null)
    const createProjectV2 = vi.fn(async () => ({ id: 'PVT_novo', number: 9 }))

    const outcome = await provisionSetupMission(
      {
        id: 'mission_5',
        project: { id: 'proj_5', wingId: 'GitOrchAI/gitorch', userId: 'user_1' },
      },
      stack,
      'gh_owner_token',
      {
        prisma: { project: { update } } as never,
        createProjectV2Client: () => ({ findProjectId, createProjectV2 }),
        resolveOwner: async () => ({ id: 'O_org_gitorchai', type: 'organization' }),
      }
    )

    expect(outcome.status).toBe('completed')
    expect(createProjectV2).toHaveBeenCalledWith({
      ownerId: 'O_org_gitorchai',
      title: 'GitOrchAI/gitorch',
    })
    expect(update).toHaveBeenCalledWith({
      where: { id: 'proj_5' },
      data: {
        runtimeConfig: {
          envConfig: { GITORCH_PROJECT_BOARD: 'GitOrchAI/9' },
        },
      },
    })
  })

  // O board é do PRODUTO agindo como ele mesmo, não do dono agindo em nome
  // dele. Com o token pessoal, criar board de ORGANIZAÇÃO devolve
  // "loureng does not have the correct permissions to execute CreateProjectV2"
  // (visto em produção): o login é user-to-server de GitHub App e não carrega
  // poder de projects. O installation token do App carrega — quando o App
  // está instalado na organização.
  test('cria o board com o installation token do App, não com o token pessoal do dono', async () => {
    const stack = fakeStack(vi.fn().mockResolvedValue({ path: '/workspace/x' }))
    const tokensUsados: string[] = []
    const repositoriosPedidos: (string | undefined)[] = []

    const outcome = await provisionSetupMission(
      {
        id: 'mission_app_token',
        project: { id: 'proj_app', wingId: 'GitOrchAI/gitorch', userId: 'user_1' },
      },
      stack,
      'gh_token_pessoal_do_dono',
      {
        prisma: { project: { update: vi.fn().mockResolvedValue({}) } } as never,
        createProjectV2Client: (token: string) => {
          tokensUsados.push(token)
          return {
            findProjectId: vi.fn(async () => null),
            createProjectV2: vi.fn(async () => ({ id: 'PVT_x', number: 3 })),
          }
        },
        resolveOwner: async () => ({ id: 'O_org', type: 'organization' }),
        mintInstallationToken: async ({ repository }) => {
          repositoriosPedidos.push(repository)
          return 'ghs_token_do_app'
        },
      }
    )

    expect(outcome.status).toBe('completed')
    expect(tokensUsados).toEqual(['ghs_token_do_app'])
    expect(repositoriosPedidos).toEqual(['GitOrchAI/gitorch'])
  })

  test('o aviso de App não instalado sai no log do servidor, não no console', async () => {
    const stack = fakeStack(vi.fn().mockResolvedValue({ path: '/workspace/x' }))
    const warn = vi.fn()

    await provisionSetupMission(
      {
        id: 'mission_log',
        project: { id: 'proj_log', wingId: 'GitOrchAI/gitorch', userId: 'user_1' },
      },
      stack,
      'gh_token_pessoal_do_dono',
      {
        prisma: { project: { update: vi.fn().mockResolvedValue({}) } } as never,
        createProjectV2Client: () => ({
          findProjectId: vi.fn(async () => null),
          createProjectV2: vi.fn(async () => ({ id: 'PVT_z', number: 5 })),
        }),
        resolveOwner: async () => ({ id: 'O_org', type: 'organization' }),
        log: { warn, info: vi.fn() },
        mintInstallationToken: async ({ onWarn }) => {
          onWarn?.('o GitHub App não está instalado em GitOrchAI')
          return null
        },
      }
    )

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('não está instalado em GitOrchAI'))
  })

  test('sem instalação do App para o repositório, o board ainda tenta com o token do dono', async () => {
    const stack = fakeStack(vi.fn().mockResolvedValue({ path: '/workspace/x' }))
    const tokensUsados: string[] = []

    await provisionSetupMission(
      {
        id: 'mission_sem_app',
        project: { id: 'proj_sem_app', wingId: 'loureng/pessoal', userId: 'user_1' },
      },
      stack,
      'gh_token_pessoal_do_dono',
      {
        prisma: { project: { update: vi.fn().mockResolvedValue({}) } } as never,
        createProjectV2Client: (token: string) => {
          tokensUsados.push(token)
          return {
            findProjectId: vi.fn(async () => null),
            createProjectV2: vi.fn(async () => ({ id: 'PVT_y', number: 4 })),
          }
        },
        resolveOwner: async () => ({ id: 'O_user', type: 'user' }),
        mintInstallationToken: async () => null,
      }
    )

    expect(tokensUsados).toEqual(['gh_token_pessoal_do_dono'])
  })

  // D13 (01/09/2026, caso real do dono): loureng/padrao-executores nasceu de
  // conta pessoal com o App JÁ instalado (mintInstallationToken emite token
  // normalmente) — mas o App é CEGO para Projects V2 de conta pessoal, e
  // createProjectV2 nega: "gitorch-ai[bot] does not have permission to
  // create projects on ownerId ...". Diferente do teste acima (App NEM
  // instalado — cai no token de LOGIN do dono, que é user-to-server do
  // GitHub App e é IGUALMENTE cego lá), aqui a única credencial que alcança é
  // a que o cliente colou à mão em /api/v1/setup/credencial-do-cliente
  // (`lerCredencialDoProjeto` — PAT clássico com escopo `project`). Terceira
  // ocorrência da mesma família em três dias (#441, #444).
  test('conta pessoal, App instalado mas sem permissão de Projects V2: retenta e cria com a credencial que o cliente colou', async () => {
    const stack = fakeStack(vi.fn().mockResolvedValue({ path: '/workspace/x' }))
    const update = vi.fn().mockResolvedValue({})
    const tokensUsados: string[] = []

    const outcome = await provisionSetupMission(
      {
        id: 'mission_conta_pessoal',
        project: { id: 'proj_pessoal', wingId: 'loureng/padrao-executores', userId: 'user_1' },
      },
      stack,
      'gh_token_login_do_dono',
      {
        prisma: { project: { update } } as never,
        createProjectV2Client: (token: string) => {
          tokensUsados.push(token)
          if (token === 'ghs_token_do_app') {
            return {
              findProjectId: vi.fn(async () => null),
              createProjectV2: vi.fn(async () => {
                throw new Error(
                  'GitHub GraphQL request failed: gitorch-ai[bot] does not have permission to create projects on ownerId U_kgDO'
                )
              }),
            }
          }
          return {
            findProjectId: vi.fn(async () => null),
            createProjectV2: vi.fn(async () => ({ id: 'PVT_pessoal', number: 11 })),
          }
        },
        resolveOwner: async () => ({ id: 'U_loureng', type: 'user' }),
        mintInstallationToken: async () => 'ghs_token_do_app',
        lerClientToken: async () => 'ghp_colado_pelo_cliente',
      }
    )

    expect(outcome.status).toBe('completed')
    expect(tokensUsados).toEqual(['ghs_token_do_app', 'ghp_colado_pelo_cliente'])
    expect(update).toHaveBeenCalledWith({
      where: { id: 'proj_pessoal' },
      data: {
        runtimeConfig: {
          envConfig: { GITORCH_PROJECT_BOARD: 'loureng/11' },
        },
      },
    })
  })

  test('conta pessoal sem credencial do cliente guardada: a negativa de permissão vira aviso ACIONÁVEL, não silêncio', async () => {
    const stack = fakeStack(vi.fn().mockResolvedValue({ path: '/workspace/x' }))
    const update = vi.fn().mockResolvedValue({})
    const warn = vi.fn()

    const outcome = await provisionSetupMission(
      {
        id: 'mission_sem_credencial',
        project: { id: 'proj_sem_cred', wingId: 'loureng/outro-repo-pessoal', userId: 'user_1' },
      },
      stack,
      'gh_token_login_do_dono',
      {
        prisma: { project: { update } } as never,
        createProjectV2Client: () => ({
          findProjectId: vi.fn(async () => null),
          createProjectV2: vi.fn(async () => {
            throw new Error(
              'GitHub GraphQL request failed: gitorch-ai[bot] does not have permission to create projects on ownerId U_yyy'
            )
          }),
        }),
        resolveOwner: async () => ({ id: 'U_loureng', type: 'user' }),
        mintInstallationToken: async () => 'ghs_token_do_app',
        lerClientToken: async () => null,
        log: { warn, info: vi.fn() },
      }
    )

    expect(outcome.status).toBe('completed')
    expect(update).not.toHaveBeenCalled()
    const avisos = warn.mock.calls.map((c) => String(c[0]))
    expect(avisos.some((m) => /permission/i.test(m))).toBe(true)
    expect(avisos.some((m) => /\/api\/v1\/setup\/credencial-do-cliente/.test(m))).toBe(true)
  })

  test('sem lerClientToken injetado (produção), o default lê lerCredencialDoProjeto do próprio prisma', async () => {
    const stack = fakeStack(vi.fn().mockResolvedValue({ path: '/workspace/x' }))
    const update = vi.fn().mockResolvedValue({})
    const findUnique = vi.fn().mockResolvedValue({ encryptedClientToken: null })

    const outcome = await provisionSetupMission(
      {
        id: 'mission_default_ler',
        project: { id: 'proj_default', wingId: 'GitOrchAI/gitorch', userId: 'user_1' },
      },
      stack,
      'gh_owner_token',
      {
        prisma: { project: { update, findUnique } } as never,
        createProjectV2Client: () => ({
          findProjectId: vi.fn(async () => null),
          createProjectV2: vi.fn(async () => ({ id: 'PVT_default', number: 21 })),
        }),
        resolveOwner: async () => ({ id: 'O_org', type: 'organization' }),
        mintInstallationToken: async () => 'ghs_app',
      }
    )

    expect(outcome.status).toBe('completed')
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'proj_default' },
      select: { encryptedClientToken: true },
    })
    expect(update).toHaveBeenCalledWith({
      where: { id: 'proj_default' },
      data: {
        runtimeConfig: { envConfig: { GITORCH_PROJECT_BOARD: 'GitOrchAI/21' } },
      },
    })
  })

  // Achado importante: `existingNumber` era código morto — nenhum chamador
  // passava, então `findProjectId` nunca rodava e TODO provisionamento criava
  // board NOVO. Finalizar o wizard 2x para o mesmo repositório (ex.: o
  // cliente reenvia o form, ou uma missão de setup é reprocessada) duplicava
  // o board. Este teste prova que, com o número JÁ gravado no projeto (de
  // uma execução anterior desta mesma função), a 2ª chamada passa
  // `existingNumber` pro findProjectId — e reusa o board em vez de criar
  // outro.
  test('projeto que já tem board gravado (2ª finalização do wizard): reusa via findProjectId, NUNCA cria outro', async () => {
    const allocateWorkspace = vi.fn().mockResolvedValue({ path: '/workspace/x' })
    const stack = fakeStack(allocateWorkspace)
    const update = vi.fn().mockResolvedValue({})
    const findProjectId = vi.fn(async () => 'PVT_existente')
    const createProjectV2 = vi.fn(async () => ({ id: 'PVT_novo_indevido', number: 999 }))

    const outcome = await provisionSetupMission(
      {
        id: 'mission_9',
        project: {
          id: 'proj_9',
          wingId: 'GitOrchAI/gitorch',
          userId: 'user_1',
          // Já gravado por uma execução anterior — é isto que a 1ª
          // finalização do wizard deixa no projeto.
          runtimeConfig: { envConfig: { GITORCH_PROJECT_BOARD: 'GitOrchAI/9' } },
        },
      },
      stack,
      'gh_owner_token',
      {
        prisma: { project: { update } } as never,
        createProjectV2Client: () => ({ findProjectId, createProjectV2 }),
        resolveOwner: async () => ({ id: 'O_org_gitorchai', type: 'organization' }),
      }
    )

    expect(outcome.status).toBe('completed')
    // findProjectId foi chamado com o NÚMERO já gravado — a checagem de
    // reuso de fato rodou, não foi pulada.
    expect(findProjectId).toHaveBeenCalledWith(
      expect.objectContaining({ login: 'GitOrchAI', number: 9 })
    )
    // Board NUNCA foi criado de novo — reusou o existente.
    expect(createProjectV2).not.toHaveBeenCalled()
    // O runtimeConfig gravado continua apontando pro MESMO board (9), não pro
    // 999 que createProjectV2 devolveria se tivesse rodado.
    expect(update).toHaveBeenCalledWith({
      where: { id: 'proj_9' },
      data: {
        runtimeConfig: {
          envConfig: { GITORCH_PROJECT_BOARD: 'GitOrchAI/9' },
        },
      },
    })
  })

  test('falha ao criar o board NÃO derruba o provisionamento (workspace já alocado fica completed)', async () => {
    const allocateWorkspace = vi.fn().mockResolvedValue({ path: '/workspace/x' })
    const stack = fakeStack(allocateWorkspace)
    const update = vi.fn().mockResolvedValue({})
    const createProjectV2 = vi.fn(async () => {
      throw new Error('Resource not accessible by integration')
    })

    const outcome = await provisionSetupMission(
      {
        id: 'mission_6',
        project: { id: 'proj_6', wingId: 'GitOrchAI/gitorch', userId: 'user_1' },
      },
      stack,
      'gh_owner_token',
      {
        prisma: { project: { update } } as never,
        createProjectV2Client: () => ({
          findProjectId: vi.fn(async () => null),
          createProjectV2,
        }),
        resolveOwner: async () => ({ id: 'O_org_gitorchai', type: 'organization' }),
      }
    )

    expect(outcome.status).toBe('completed')
    expect(update).not.toHaveBeenCalled()
  })

  test('sem prisma nas deps, pula o board por completo (não toca rede nem grava nada)', async () => {
    const allocateWorkspace = vi.fn().mockResolvedValue({ path: '/workspace/x' })
    const stack = fakeStack(allocateWorkspace)
    const resolveOwner = vi.fn()

    const outcome = await provisionSetupMission(
      {
        id: 'mission_7',
        project: { id: 'proj_7', wingId: 'GitOrchAI/gitorch', userId: 'user_1' },
      },
      stack,
      'gh_owner_token',
      { resolveOwner }
    )

    expect(outcome.status).toBe('completed')
    expect(resolveOwner).not.toHaveBeenCalled()
  })

  test('preserva o resto de runtimeConfig/envConfig já gravado ao adicionar o board', async () => {
    const allocateWorkspace = vi.fn().mockResolvedValue({ path: '/workspace/x' })
    const stack = fakeStack(allocateWorkspace)
    const update = vi.fn().mockResolvedValue({})

    await provisionSetupMission(
      {
        id: 'mission_8',
        project: {
          id: 'proj_8',
          wingId: 'GitOrchAI/gitorch',
          userId: 'user_1',
          runtimeConfig: { envConfig: { OUTRA_CHAVE: 'x' }, outroCampo: true },
        },
      },
      stack,
      'gh_owner_token',
      {
        prisma: { project: { update } } as never,
        createProjectV2Client: () => ({
          findProjectId: vi.fn(async () => null),
          createProjectV2: vi.fn(async () => ({ id: 'PVT', number: 3 })),
        }),
        resolveOwner: async () => ({ id: 'O_x', type: 'organization' }),
      }
    )

    expect(update).toHaveBeenCalledWith({
      where: { id: 'proj_8' },
      data: {
        runtimeConfig: {
          outroCampo: true,
          envConfig: { OUTRA_CHAVE: 'x', GITORCH_PROJECT_BOARD: 'GitOrchAI/3' },
        },
      },
    })
  })

  // IMPORTANTE (leva D): SEM `createProjectV2Client` injetado (o caso real de
  // produção, quando o call site de `processSetupMissions` deixasse de
  // passá-lo), o default caía num `ProjectV2Client` sem teto — alcançável
  // pelo tique (`processSetupMissions` → `tick()`) sob `tickEmAndamento`,
  // mesma classe de defeito do Crítico.
  test('SEM createProjectV2Client injetado, o ProjectV2Client default ainda carrega um AbortSignal não abortado', async () => {
    const stack = fakeStack(vi.fn().mockResolvedValue({ path: '/workspace/x' }))
    const chamadas: Array<{ init: RequestInit | undefined }> = []
    const original = global.fetch
    global.fetch = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      chamadas.push({ init })
      const u = String(url)
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })
      if (u.endsWith('/graphql')) {
        const body = JSON.parse(String(init?.body)) as { query: string }
        if (body.query.includes('GetProjectId') || body.query.includes('projectV2(number')) {
          return json({ data: { repositoryOwner: { __typename: 'User', projectV2: null } } })
        }
        if (body.query.includes('createProjectV2')) {
          return json({
            data: { createProjectV2: { projectV2: { id: 'PVT_default', number: 1 } } },
          })
        }
        return json({ data: {} })
      }
      return json({})
    }) as unknown as typeof fetch

    try {
      const outcome = await provisionSetupMission(
        {
          id: 'mission_sem_client_injetado',
          project: { id: 'proj_default', wingId: 'GitOrchAI/gitorch', userId: 'user_1' },
        },
        stack,
        'gh_owner_token',
        {
          prisma: { project: { update: vi.fn().mockResolvedValue({}) } } as never,
          resolveOwner: async () => ({ id: 'O_org', type: 'organization' }),
        }
      )
      expect(outcome.status).toBe('completed')
    } finally {
      global.fetch = original
    }

    expect(chamadas.length).toBeGreaterThan(0)
    for (const { init } of chamadas) {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(init?.signal?.aborted).toBe(false)
    }
  })
})

// O teto de concorrência (MAX_CONCURRENT_MISSIONS) passa a cobrir TAMBÉM o
// wizard, não só a cadência (spec Onda 2 / F1.1.6). processSetupMissions usa
// esta função pura para decidir o que cabe nesta rodada; a fiação com o
// Prisma (contagem real de pending+running) fica no plugin, não aqui.
describe('selectClaimableSetupMissions', () => {
  test('teto=1 e 1 missão já rodando (fora deste lote): a 2ª setup mission pendente fica na fila', () => {
    const pendingFifo = [{ id: 'setup_2' }]

    const claimable = selectClaimableSetupMissions(pendingFifo, /* otherActiveCount */ 1, 1)

    expect(claimable).toEqual([])
  })

  test('sem nada mais ativo e teto=2, as 2 primeiras pendentes (FIFO) são reivindicadas; a 3ª fica na fila', () => {
    const pendingFifo = [{ id: 'setup_1' }, { id: 'setup_2' }, { id: 'setup_3' }]

    const claimable = selectClaimableSetupMissions(pendingFifo, 0, 2)

    expect(claimable.map((m) => m.id)).toEqual(['setup_1', 'setup_2'])
  })

  test('1 outra ativa e teto=2: só a mais antiga da fila é reivindicada', () => {
    const pendingFifo = [{ id: 'setup_1' }, { id: 'setup_2' }]

    const claimable = selectClaimableSetupMissions(pendingFifo, 1, 2)

    expect(claimable.map((m) => m.id)).toEqual(['setup_1'])
  })

  test('capacidade sobrando (teto alto): todas as pendentes são reivindicadas', () => {
    const pendingFifo = [{ id: 'setup_1' }, { id: 'setup_2' }]

    const claimable = selectClaimableSetupMissions(pendingFifo, 0, 5)

    expect(claimable.map((m) => m.id)).toEqual(['setup_1', 'setup_2'])
  })

  test('sem capacidade nenhuma (outras ativas já no teto): fila inteira espera', () => {
    const pendingFifo = [{ id: 'setup_1' }, { id: 'setup_2' }]

    const claimable = selectClaimableSetupMissions(pendingFifo, 3, 2)

    expect(claimable).toEqual([])
  })

  test('fila vazia: nada a reivindicar, sem tocar no teto', () => {
    expect(selectClaimableSetupMissions([], 0, 1)).toEqual([])
  })
})
