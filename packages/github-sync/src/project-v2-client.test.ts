import { expect, test } from 'vitest'

import {
  ProjectV2Client,
  type GraphQLRequest,
  CampoDeIteracaoAusenteError,
  CampoNumericoAusenteError,
  NomeDeCampoEmConflitoError,
} from './project-v2-client'

test('sends addProjectV2ItemById with deterministic variables', async () => {
  const calls: GraphQLRequest[] = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return { data: { addProjectV2ItemById: { item: { id: 'PVTI_1' } } } }
    },
  })

  await client.addItemById({
    projectId: 'PVT_1',
    contentId: 'I_1',
  })

  expect(calls).toEqual([
    expect.objectContaining({
      variables: { projectId: 'PVT_1', contentId: 'I_1' },
    }),
  ])
})

test('sends updateProjectV2ItemFieldValue for a single select field', async () => {
  const calls: GraphQLRequest[] = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } } }
    },
  })

  await client.updateSingleSelectField({
    projectId: 'PVT_1',
    itemId: 'PVTI_1',
    fieldId: 'PVTSSF_status',
    optionId: 'ready-option',
  })

  expect(calls).toEqual([
    expect.objectContaining({
      variables: {
        projectId: 'PVT_1',
        itemId: 'PVTI_1',
        fieldId: 'PVTSSF_status',
        optionId: 'ready-option',
      },
    }),
  ])
})

test('resolves a user project node id by number', async () => {
  const calls: GraphQLRequest[] = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return { data: { user: { projectV2: { id: 'PVT_user_1' } } } }
    },
  })

  const id = await client.getProjectId({ login: 'dono-exemplo', number: 3, ownerType: 'user' })

  expect(id).toBe('PVT_user_1')
  expect(calls[0].variables).toEqual({ login: 'dono-exemplo', number: 3 })
  expect(calls[0].query).toContain('user(login: $login)')
})

test('resolves an organization project node id by number', async () => {
  const calls: GraphQLRequest[] = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return { data: { organization: { projectV2: { id: 'PVT_org_1' } } } }
    },
  })

  const id = await client.getProjectId({
    login: 'gitorch-ai',
    number: 1,
    ownerType: 'organization',
  })

  expect(id).toBe('PVT_org_1')
  expect(calls[0].query).toContain('organization(login: $login)')
})

test('reads the iterations of a Sprint field by name', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () => ({
      data: {
        node: {
          fields: {
            nodes: [
              { __typename: 'ProjectV2SingleSelectField', id: 'F_status', name: 'Status' },
              {
                __typename: 'ProjectV2IterationField',
                id: 'F_sprint',
                name: 'Sprint',
                configuration: {
                  iterations: [
                    { id: 'IT_1', title: 'Sprint 1', startDate: '2026-07-06', duration: 7 },
                  ],
                },
              },
            ],
          },
        },
      },
    }),
  })

  const field = await client.getIterationField({ projectId: 'PVT_1', fieldName: 'Sprint' })

  expect(field).toEqual({
    fieldId: 'F_sprint',
    iterations: [{ id: 'IT_1', title: 'Sprint 1', startDate: '2026-07-06', duration: 7 }],
  })
})

test('throws when the named iteration field is absent', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () => ({ data: { node: { fields: { nodes: [] } } } }),
  })

  await expect(
    client.getIterationField({ projectId: 'PVT_1', fieldName: 'Sprint' })
  ).rejects.toThrow('Iteration field "Sprint" not found')
})

test('sets the Sprint iteration on an item', async () => {
  const calls: GraphQLRequest[] = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } } }
    },
  })

  await client.setIterationField({
    projectId: 'PVT_1',
    itemId: 'PVTI_1',
    fieldId: 'F_sprint',
    iterationId: 'IT_1',
  })

  expect(calls[0].variables).toEqual({
    projectId: 'PVT_1',
    itemId: 'PVTI_1',
    fieldId: 'F_sprint',
    iterationId: 'IT_1',
  })
  expect(calls[0].query).toContain('iterationId: $iterationId')
})

test('links a sub-issue to its parent (Epic -> Feature -> Task hierarchy)', async () => {
  const calls: GraphQLRequest[] = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return { data: { addSubIssue: { issue: { id: 'I_parent' } } } }
    },
  })

  await client.addSubIssue({ issueId: 'I_parent', subIssueId: 'I_child' })

  expect(calls[0].variables).toEqual({ issueId: 'I_parent', subIssueId: 'I_child' })
  expect(calls[0].query).toContain(
    'addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }'
  )
})

test('surfaces GitHub GraphQL errors with actionable messages', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () => ({ errors: [{ message: 'Project not found' }] }),
  })

  await expect(client.archiveItem({ projectId: 'PVT_1', itemId: 'PVTI_1' })).rejects.toThrow(
    'GitHub GraphQL request failed: Project not found'
  )
})

test('findProjectId returns the node id when the board exists', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () => ({ data: { user: { projectV2: { id: 'PVT_found' } } } }),
  })

  const id = await client.findProjectId({ login: 'dono-exemplo', number: 3, ownerType: 'user' })
  expect(id).toBe('PVT_found')
})

test('findProjectId returns null (does NOT throw) when the board is absent', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    // Dono existe, mas não tem o Project v2 #N — o resolver da coleta de
    // contexto trata isso como "criar", não como erro.
    request: async () => ({ data: { user: { projectV2: null } } }),
  })

  const id = await client.findProjectId({ login: 'dono-exemplo', number: 99, ownerType: 'user' })
  expect(id).toBeNull()
})

test('getProjectId still throws when the board is absent (contrato estrito do PO/SM)', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () => ({ data: { organization: { projectV2: null } } }),
  })

  await expect(
    client.getProjectId({ login: 'gitorch-ai', number: 7, ownerType: 'organization' })
  ).rejects.toThrow('Project v2 #7 not found for organization "gitorch-ai".')
})

test('createProjectV2 creates a board and returns its id + number', async () => {
  const calls: GraphQLRequest[] = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return { data: { createProjectV2: { projectV2: { id: 'PVT_new', number: 12 } } } }
    },
  })

  const created = await client.createProjectV2({ ownerId: 'U_owner', title: 'GitOrch — contexto' })

  expect(created).toEqual({ id: 'PVT_new', number: 12 })
  expect(calls[0].variables).toEqual({ ownerId: 'U_owner', title: 'GitOrch — contexto' })
  expect(calls[0].query).toContain('createProjectV2(input: { ownerId: $ownerId, title: $title }')
})

// Achado em produção: o quadro nascia órfão — `organization.projectsV2` o via,
// mas `repository.projectsV2.totalCount` ficava em 0 (não aparecia na aba
// /projects do repositório). `createProjectV2` cria o board pendurado no
// DONO; sem esta mutation ele nunca é anunciado ao repositório.
test('linkProjectV2ToRepository liga o board recém-criado ao repositório', async () => {
  const calls: GraphQLRequest[] = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return { data: { linkProjectV2ToRepository: { repository: { id: 'R_repo' } } } }
    },
  })

  const id = await client.linkProjectV2ToRepository({
    projectId: 'PVT_new',
    repositoryId: 'R_repo',
  })

  expect(id).toBe('R_repo')
  expect(calls[0].variables).toEqual({ projectId: 'PVT_new', repositoryId: 'R_repo' })
  expect(calls[0].query).toContain(
    'linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repositoryId }'
  )
})

// A esteira precisa DESCOBRIR quadro, não só criar às cegas. Sem estas duas
// consultas ela ignora um quadro que o cliente já mantém e tenta criar outro
// por cima — foi o que aconteceu num repositório que já tinha dois.

test('lista os quadros já ligados a um repositório', async () => {
  const calls: GraphQLRequest[] = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return {
        data: {
          repository: {
            projectsV2: {
              nodes: [
                { id: 'PVT_a', number: 2, title: 'dono/repo' },
                { id: 'PVT_b', number: 9, title: 'Outro quadro' },
              ],
            },
          },
        },
      }
    },
  })

  const quadros = await client.listarQuadrosDoRepositorio({ owner: 'dono', repo: 'repo' })

  // Itens e campos entram SEMPRE no retorno: a resposta que não os traz vale
  // zero, e zero perde o desempate — nunca vira "não sei" silencioso.
  expect(quadros).toEqual([
    { id: 'PVT_a', number: 2, title: 'dono/repo', itensCount: 0, camposCount: 0 },
    { id: 'PVT_b', number: 9, title: 'Outro quadro', itensCount: 0, camposCount: 0 },
  ])
  expect(calls[0]?.variables).toEqual({ owner: 'dono', repo: 'repo' })
})

test('repositório sem quadro ligado devolve lista vazia, não erro', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () => ({ data: { repository: { projectsV2: { nodes: [] } } } }),
  })

  await expect(client.listarQuadrosDoRepositorio({ owner: 'dono', repo: 'repo' })).resolves.toEqual(
    []
  )
})

test('lista os quadros da conta, distinguindo pessoa de organização', async () => {
  const calls: GraphQLRequest[] = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return {
        data: { organization: { projectsV2: { nodes: [{ id: 'PVT_c', number: 1, title: 'x' }] } } },
      }
    },
  })

  const quadros = await client.listarQuadrosDaConta({
    login: 'umaOrg',
    ownerType: 'organization',
  })

  expect(quadros).toEqual([{ id: 'PVT_c', number: 1, title: 'x' }])
  expect(calls[0]?.query).toContain('organization(login:')
  expect(calls[0]?.query).not.toContain('user(login:')
})

test('conta de pessoa consulta o campo de usuário', async () => {
  const calls: GraphQLRequest[] = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return { data: { user: { projectsV2: { nodes: [] } } } }
    },
  })

  await client.listarQuadrosDaConta({ login: 'umaPessoa', ownerType: 'user' })

  expect(calls[0]?.query).toContain('user(login:')
  expect(calls[0]?.query).not.toContain('organization(login:')
})

// O App do produto é CEGO para quadro de conta pessoal: a consulta responde
// com sucesso e a conta vem nula, mesmo havendo quadros. Tratar isso como
// "não existe nenhum" faria a esteira tentar criar um por cima; o certo é
// devolver lista vazia e deixar quem chama decidir com o aviso na mão.
test('conta invisível para a credencial atual devolve lista vazia', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () => ({ data: { user: null } }),
  })

  await expect(
    client.listarQuadrosDaConta({ login: 'umaPessoa', ownerType: 'user' })
  ).resolves.toEqual([])
})

// Descoberta por EVIDÊNCIA: o quadro deste repositório é aquele onde as issues
// dele já estão. Casar por semelhança de título foi rejeitado — a normalização
// colapsava separadores e um quadro acabou ligado a um repositório sem relação.

// Medido num repositório real: o quadro criado pelo produto aparecia já na
// primeira página, e o quadro curado à mão — o que deve vencer o desempate —
// só na terceira. Parar no primeiro achado elegeria justamente o pior dos dois.
test('não para no primeiro quadro: continua varrendo para achar os demais', async () => {
  const calls: GraphQLRequest[] = []
  const paginas = [
    {
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: true, endCursor: 'C1' },
            nodes: [
              {
                number: 1,
                projectItems: {
                  nodes: [{ project: { id: 'PVT_novo', number: 9, title: 'novo', closed: false } }],
                },
              },
            ],
          },
        },
      },
    },
    {
      data: {
        repository: {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 2,
                projectItems: {
                  nodes: [
                    { project: { id: 'PVT_antigo', number: 3, title: 'antigo', closed: false } },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  ]
  let i = 0
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return paginas[i++] as never
    },
  })

  const achados = await client.descobrirQuadrosPorIssues({ owner: 'dono', repo: 'repo' })

  expect(achados).toEqual([
    { id: 'PVT_novo', number: 9, title: 'novo', closed: false, issuesDesteRepo: 1 },
    { id: 'PVT_antigo', number: 3, title: 'antigo', closed: false, issuesDesteRepo: 1 },
  ])
  expect(calls).toHaveLength(2)
  expect(calls[1]?.variables).toMatchObject({ cursor: 'C1' })
})

test('respeita o teto de páginas quando nada é encontrado', async () => {
  let chamadas = 0
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () => {
      chamadas++
      return {
        data: {
          repository: {
            issues: { pageInfo: { hasNextPage: true, endCursor: 'C' }, nodes: [] },
          },
        },
      } as never
    },
  })

  const achados = await client.descobrirQuadrosPorIssues({
    owner: 'dono',
    repo: 'repo',
    maxPaginas: 3,
  })

  expect(achados).toEqual([])
  expect(chamadas).toBe(3)
})

test('conta quantas issues deste repositório cada quadro tem', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () =>
      ({
        data: {
          repository: {
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  number: 1,
                  projectItems: {
                    nodes: [{ project: { id: 'PVT_a', number: 3, title: 'A', closed: false } }],
                  },
                },
                {
                  number: 2,
                  projectItems: {
                    nodes: [
                      { project: { id: 'PVT_a', number: 3, title: 'A', closed: false } },
                      { project: { id: 'PVT_b', number: 9, title: 'B', closed: false } },
                    ],
                  },
                },
              ],
            },
          },
        },
      }) as never,
  })

  const achados = await client.descobrirQuadrosPorIssues({ owner: 'dono', repo: 'repo' })

  expect(achados).toEqual([
    { id: 'PVT_a', number: 3, title: 'A', closed: false, issuesDesteRepo: 2 },
    { id: 'PVT_b', number: 9, title: 'B', closed: false, issuesDesteRepo: 1 },
  ])
})

// Para desempatar (quadro mais rico vence) e para não sequestrar quadro
// compartilhado, é preciso saber quantos campos o quadro tem e de quais
// repositórios são os itens dentro dele.
test('detalha um quadro: quantidade de campos e repositórios de dentro', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () =>
      ({
        data: {
          node: {
            fields: { totalCount: 23 },
            items: {
              nodes: [
                { content: { repository: { nameWithOwner: 'dono/repo' } } },
                { content: { repository: { nameWithOwner: 'dono/repo' } } },
                { content: { repository: { nameWithOwner: 'outro/alheio' } } },
                { content: null },
              ],
            },
          },
        },
      }) as never,
  })

  const d = await client.detalharQuadro({ projectId: 'PVT_a', repositorio: 'dono/repo' })

  expect(d).toEqual({ camposCount: 23, outrosRepositorios: ['outro/alheio'] })
})

test('quadro só com itens deste repositório não tem outros repositórios', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () =>
      ({
        data: {
          node: {
            fields: { totalCount: 14 },
            items: { nodes: [{ content: { repository: { nameWithOwner: 'dono/repo' } } }] },
          },
        },
      }) as never,
  })

  await expect(
    client.detalharQuadro({ projectId: 'PVT_a', repositorio: 'dono/repo' })
  ).resolves.toEqual({ camposCount: 14, outrosRepositorios: [] })
})

// Quadro curado à mão passa de cem itens com facilidade — o do caso real tem
// cento e quarenta e seis. Olhar só a primeira página faria um quadro
// compartilhado passar por exclusivo, e a esteira despejaria o backlog deste
// projeto dentro do quadro de outro. Exatamente o desastre que a descoberta por
// evidência existe para evitar, só que por outra porta.
test('detalharQuadro pagina os itens: repositório alheio além do centésimo é visto', async () => {
  const paginas = [
    {
      data: {
        node: {
          fields: { totalCount: 23 },
          items: {
            pageInfo: { hasNextPage: true, endCursor: 'C1' },
            nodes: [{ content: { repository: { nameWithOwner: 'dono/repo' } } }],
          },
        },
      },
    },
    {
      data: {
        node: {
          fields: { totalCount: 23 },
          items: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ content: { repository: { nameWithOwner: 'outro/alheio' } } }],
          },
        },
      },
    },
  ]
  let i = 0
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () => paginas[i++] as never,
  })

  const d = await client.detalharQuadro({ projectId: 'PVT_a', repositorio: 'dono/repo' })

  expect(d).toEqual({ camposCount: 23, outrosRepositorios: ['outro/alheio'] })
})

test('detalharQuadro respeita um teto de páginas de itens', async () => {
  let chamadas = 0
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () => {
      chamadas++
      return {
        data: {
          node: {
            fields: { totalCount: 5 },
            items: {
              pageInfo: { hasNextPage: true, endCursor: 'C' },
              nodes: [{ content: { repository: { nameWithOwner: 'dono/repo' } } }],
            },
          },
        },
      } as never
    },
  })

  await client.detalharQuadro({ projectId: 'PVT_a', repositorio: 'dono/repo', maxPaginas: 3 })

  expect(chamadas).toBe(3)
})

// As duas mutações abaixo ESCREVEM no quadro real do cliente e eram as únicas
// do arquivo sem teste nenhum — a operação mais perigosa era a menos coberta.

test('criarCampoDeIteracao manda nome, duração e início, e devolve o campo criado', async () => {
  const calls: GraphQLRequest[] = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return {
        data: {
          createProjectV2Field: { projectV2Field: { id: 'F_novo', name: 'Sprint' } },
        },
      }
    },
  })

  const campo = await client.criarCampoDeIteracao({
    projectId: 'PVT_1',
    fieldName: 'Sprint',
    duracaoEmDias: 3,
    inicio: '2026-08-29',
  })

  expect(campo).toEqual({ fieldId: 'F_novo', name: 'Sprint' })
  // `iterations` é OBRIGATÓRIO, e a falta dele passou despercebida por aqui.
  //
  // Este teste já existiu afirmando só as quatro primeiras variáveis, e passava
  // verde — contra um fake que aceita qualquer coisa. A API real recusa:
  // "Argument 'iterations' on InputObject
  // 'ProjectV2IterationFieldConfigurationInput' is required". Ou seja, a
  // mutation NUNCA funcionou em produção e o verde daqui dizia o contrário.
  // Introspection contra a API de produção (30/08/2026): os três campos são
  // NON_NULL — startDate, duration e iterations.
  expect(calls[0]?.variables).toEqual({
    projectId: 'PVT_1',
    name: 'Sprint',
    duration: 3,
    startDate: '2026-08-29',
    iterations: [{ startDate: '2026-08-29', duration: 3, title: 'Sprint 1' }],
  })
  // Sem dataType ITERATION o GitHub cria um campo de texto chamado "Sprint" —
  // parece certo na tela e o Roadmap continua sem eixo de tempo.
  expect(calls[0]?.query).toContain('dataType: ITERATION')
  // Os três argumentos da configuração, cada um conferido por si: assim, tirar
  // qualquer um deles reprova aqui em vez de só na chamada real.
  expect(calls[0]?.query).toContain('duration: $duration')
  expect(calls[0]?.query).toContain('startDate: $startDate')
  expect(calls[0]?.query).toContain('iterations: $iterations')
})

test('configurarCampoDeIteracao ATUALIZA o campo existente, sem recriar', async () => {
  const calls: GraphQLRequest[] = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return { data: { updateProjectV2Field: { projectV2Field: { id: 'F_9' } } } }
    },
  })

  const fieldId = await client.configurarCampoDeIteracao({
    projectId: 'PVT_9',
    fieldId: 'F_9',
    fieldName: 'Sprint',
    duracaoEmDias: 3,
    inicio: '2026-08-29',
  })

  expect(fieldId).toBe('F_9')
  // updateProjectV2Field preserva o vínculo dos itens que já apontam para o
  // campo; createProjectV2Field os deixaria órfãos.
  expect(calls[0]?.query).toContain('updateProjectV2Field')
  expect(calls[0]?.query).not.toContain('createProjectV2Field')
  expect(calls[0]?.variables).toMatchObject({ fieldId: 'F_9', duration: 3 })
})

test('erro do GraphQL na criação SOBE — não vira sucesso silencioso', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () => ({ errors: [{ message: 'Resource not accessible by integration' }] }),
  })

  await expect(
    client.criarCampoDeIteracao({
      projectId: 'PVT_1',
      fieldName: 'Sprint',
      duracaoEmDias: 3,
      inicio: '2026-08-29',
    })
  ).rejects.toThrow('not accessible')
})

test('campo de iteração ausente lança o erro TIPADO, não um Error qualquer', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () => ({
      data: { node: { fields: { nodes: [{ id: 'F_1', name: 'Status' }] } } },
    }),
  })

  // Quem chama trata a ausência criando o campo. Se um erro de rede chegasse
  // como o mesmo tipo, o produto criaria um segundo campo Sprint por engano.
  await expect(
    client.getIterationField({ projectId: 'PVT_1', fieldName: 'Sprint' })
  ).rejects.toBeInstanceOf(CampoDeIteracaoAusenteError)
})

test('o quadro traz `closed`, que é o que barra quadro arquivado', async () => {
  // O consumidor (decidirQuadro) descarta arquivado antes de qualquer regra.
  // Sem `closed` chegando de verdade, essa promessa não vale nada.
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () => ({
      data: {
        repository: {
          projectsV2: {
            nodes: [
              { id: 'PVT_vivo', number: 2, title: 'dono/repo', closed: false },
              { id: 'PVT_morto', number: 3, title: 'antigo', closed: true },
            ],
          },
        },
      },
    }),
  })

  const quadros = await client.listarQuadrosDoRepositorio({ owner: 'dono', repo: 'repo' })

  expect(quadros).toEqual([
    { id: 'PVT_vivo', number: 2, title: 'dono/repo', closed: false, itensCount: 0, camposCount: 0 },
    { id: 'PVT_morto', number: 3, title: 'antigo', closed: true, itensCount: 0, camposCount: 0 },
  ])
})

// ---------------------------------------------------------------------------
// Paginação do quadro. Medido em 31/08 no quadro do dono: `items(first: 100)`
// sem cursor trazia 100 de 118. Os 18 que sobravam não davam erro — sumiam. E
// eram justamente as issues #305 a #344, entre elas as que o dev assíncrono
// estava trabalhando naquele instante.
// ---------------------------------------------------------------------------

/** Uma página de resposta do GraphQL, no formato que o GitHub devolve. */
function paginaDeItens(
  nodes: Array<{
    id: string
    numero: number
    iteracao?: string | null
    peso?: number | null
    corpo?: string | null
  }>,
  proxima: string | null
) {
  return {
    data: {
      node: {
        items: {
          pageInfo: { hasNextPage: proxima !== null, endCursor: proxima },
          nodes: nodes.map((n) => ({
            id: n.id,
            content: { number: n.numero, ...(n.corpo !== undefined ? { corpo: n.corpo } : {}) },
            fieldValueByName: n.iteracao ? { iterationId: n.iteracao } : null,
            pesoValue: typeof n.peso === 'number' ? { number: n.peso } : null,
          })),
        },
      },
    },
  }
}

test('listarItensDoQuadro traz TODAS as páginas, não só a primeira', async () => {
  const cursores: Array<string | null> = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      const vars = request.variables as { cursor: string | null }
      cursores.push(vars.cursor)
      // Primeira volta devolve 2 itens e diz que há mais; a segunda fecha.
      return vars.cursor === null
        ? paginaDeItens(
            [
              { id: 'PVTI_1', numero: 36 },
              { id: 'PVTI_2', numero: 37 },
            ],
            'CURSOR_2'
          )
        : paginaDeItens([{ id: 'PVTI_3', numero: 344 }], null)
    },
  })

  const itens = await client.listarItensDoQuadro('PVT_1')

  // O item da segunda página é o que sumia. Sem paginação, este teste falha
  // com 2 itens em vez de 3, e o pedido 344 nunca aparece.
  expect(itens.map((i) => i.pedido)).toEqual([36, 37, 344])
  expect(cursores).toEqual([null, 'CURSOR_2'])
})

test('a query de itens PEDE a próxima página — o TEXTO, não só o mock', async () => {
  // Este teste existe porque o mock deste arquivo é CEGO para a query: ele
  // decide a resposta olhando `variables.cursor` e nunca lê o texto enviado.
  // Prova feita à mão: tirando `after: $cursor` da query, os três testes de
  // paginação acima continuam VERDES — e contra o GitHub real toda página
  // volta a ser a primeira, que é o defeito dos 18 itens sumidos de novo.
  // Aqui o objeto do exame é a query, não o resultado.
  const calls: GraphQLRequest[] = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return paginaDeItens([{ id: 'PVTI_1', numero: 36 }], null)
    },
  })

  await client.listarItensDoQuadro('PVT_1')

  const query = calls[0]!.query
  expect(query).toContain('$cursor: String')
  expect(query).toContain('after: $cursor')
  expect(query).toContain('pageInfo { hasNextPage endCursor }')
})

test('sem campo de sprint o seletor NÃO é pedido — diretiva, não nome inventado', async () => {
  // A versão anterior mandava um espaço como nome de campo e CONTAVA com o
  // GitHub responder `fieldValueByName: null` sem erro. Isso é comportamento
  // de servidor, não contrato: nenhum teste consegue prová-lo, e este arquivo
  // já carrega a cicatriz de `criarCampoDeIteracao`, que passava verde contra
  // um fake permissivo enquanto a API real recusava a chamada.
  //
  // `@include(if:)` é built-in da especificação do GraphQL (Seção 3, sobre
  // FIELD): com `if: false` o seletor não é executado, e nada mais depende de
  // como o servidor trata um nome que não existe.
  const calls: GraphQLRequest[] = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return paginaDeItens([{ id: 'PVTI_1', numero: 36 }], null)
    },
  })

  await client.listarItensDoQuadro('PVT_1')
  await client.listarItensDoQuadro('PVT_1', { campoDeSprint: 'Sprint' })

  expect(calls[0]!.query).toContain('fieldValueByName(name: $campo) @include(if: $querSprint)')
  // Quem não quer a sprint desliga o seletor e não manda nome nenhum: o
  // espaço mágico deixou de existir.
  expect(calls[0]!.variables.querSprint).toBe(false)
  expect(calls[0]!.variables.campo).toBe('')
  // Quem quer, liga e manda o nome de verdade.
  expect(calls[1]!.variables.querSprint).toBe(true)
  expect(calls[1]!.variables.campo).toBe('Sprint')
})

test('listarItensDoQuadro devolve a sprint de cada item na mesma consulta', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () =>
      paginaDeItens(
        [
          { id: 'PVTI_1', numero: 36, iteracao: 'iter_a' },
          { id: 'PVTI_2', numero: 37 },
        ],
        null
      ),
  })

  const itens = await client.listarItensDoQuadro('PVT_1', { campoDeSprint: 'Sprint' })

  // Quem já está no ciclo e quem não está, sem uma segunda volta ao GitHub.
  expect(itens).toEqual([
    { itemId: 'PVTI_1', pedido: 36, iteracaoId: 'iter_a', peso: null, corpo: null },
    { itemId: 'PVTI_2', pedido: 37, iteracaoId: null, peso: null, corpo: null },
  ])
})

test('sem campo de peso o seletor NÃO é pedido — mesma diretiva do campo de sprint', async () => {
  const calls: GraphQLRequest[] = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return paginaDeItens([{ id: 'PVTI_1', numero: 36 }], null)
    },
  })

  await client.listarItensDoQuadro('PVT_1')
  await client.listarItensDoQuadro('PVT_1', { campoDePeso: 'Peso' })

  expect(calls[0]!.query).toContain(
    'pesoValue: fieldValueByName(name: $campoDePeso) @include(if: $querPeso)'
  )
  expect(calls[0]!.variables.querPeso).toBe(false)
  expect(calls[0]!.variables.campoDePeso).toBe('')
  expect(calls[1]!.variables.querPeso).toBe(true)
  expect(calls[1]!.variables.campoDePeso).toBe('Peso')
})

test('listarItensDoQuadro devolve o peso de cada item na mesma consulta (L3-T8/D1)', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () =>
      paginaDeItens(
        [
          { id: 'PVTI_1', numero: 36, peso: 13 },
          { id: 'PVTI_2', numero: 37 },
        ],
        null
      ),
  })

  const itens = await client.listarItensDoQuadro('PVT_1', { campoDePeso: 'Peso' })

  // Quem tem peso planejado e quem ainda não tem, sem segunda volta ao GitHub.
  // `null` — nunca 0 — para "não sei" nunca ser confundido com "peso zero".
  expect(itens).toEqual([
    { itemId: 'PVTI_1', pedido: 36, iteracaoId: null, peso: 13, corpo: null },
    { itemId: 'PVTI_2', pedido: 37, iteracaoId: null, peso: null, corpo: null },
  ])
})

test('listarItensDoQuadro lê sprint E peso juntos, cada seletor independente do outro', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () =>
      paginaDeItens([{ id: 'PVTI_1', numero: 36, iteracao: 'iter_a', peso: 5 }], null),
  })

  const itens = await client.listarItensDoQuadro('PVT_1', {
    campoDeSprint: 'Sprint',
    campoDePeso: 'Peso',
  })

  expect(itens).toEqual([
    { itemId: 'PVTI_1', pedido: 36, iteracaoId: 'iter_a', peso: 5, corpo: null },
  ])
})

// D8 — backfill dos itens existentes: ler o CORPO da issue na mesma consulta
// (mesmo motivo de sprint/peso — evitar uma segunda volta ao GitHub por
// item, desta vez uma chamada REST por issue, que o backfill de 124 itens
// pagaria uma a uma). Mesma diretiva `@include(if:)`, mesmo motivo: sem ela
// pedir o corpo sempre custaria a resposta inteira para quem só quer
// posição/sprint/peso.

test('sem pedir o corpo, o seletor NÃO é enviado — mesma diretiva de sprint/peso', async () => {
  const calls: GraphQLRequest[] = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return paginaDeItens([{ id: 'PVTI_1', numero: 36 }], null)
    },
  })

  await client.listarItensDoQuadro('PVT_1')
  await client.listarItensDoQuadro('PVT_1', { comCorpo: true })

  expect(calls[0]!.query).toContain('corpo: body @include(if: $comCorpo)')
  expect(calls[0]!.variables.comCorpo).toBe(false)
  expect(calls[1]!.variables.comCorpo).toBe(true)
})

test('listarItensDoQuadro devolve o corpo de cada item quando pedido (D8, backfill)', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () =>
      paginaDeItens(
        [
          { id: 'PVTI_1', numero: 36, corpo: '<!-- m --># Peso\n\n**5**' },
          { id: 'PVTI_2', numero: 37 },
        ],
        null
      ),
  })

  const itens = await client.listarItensDoQuadro('PVT_1', { comCorpo: true })

  expect(itens).toEqual([
    {
      itemId: 'PVTI_1',
      pedido: 36,
      iteracaoId: null,
      peso: null,
      corpo: '<!-- m --># Peso\n\n**5**',
    },
    { itemId: 'PVTI_2', pedido: 37, iteracaoId: null, peso: null, corpo: null },
  ])
})

test('sem pedir o corpo, o campo vem null — não confunde "não pedi" com "corpo vazio"', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () => paginaDeItens([{ id: 'PVTI_1', numero: 36 }], null),
  })

  const itens = await client.listarItensDoQuadro('PVT_1')

  expect(itens[0]!.corpo).toBeNull()
})

/**
 * O teto de páginas do cliente. Não é importável (é privado), então o valor
 * vive aqui e os testes provam que o laço para exatamente nele.
 */
const PAGINAS_ATE_O_TETO = 20

// Os dois testes seguintes andam EM PAR e de propósito. Nos dois o cliente lê
// as mesmas 20 páginas e devolve os mesmos 20 itens: pelo resultado, "acabou"
// e "cortei no teto" são indistinguíveis. Só o aviso os separa. Um teste
// sozinho passaria com um `onTruncado` disparado sempre — ou nunca.

test('listarItensDoQuadro AVISA quando o teto de páginas cortou a leitura', async () => {
  // Um quadro que nunca acaba: toda página diz que há próxima.
  const cursores: Array<string | null> = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      const vars = request.variables as { cursor: string | null }
      cursores.push(vars.cursor)
      // Cursor novo a cada volta: se o laço reenviasse o mesmo, a lista de
      // cursores denunciaria — girar na mesma página gasta cota e não anda.
      return paginaDeItens(
        [{ id: `PVTI_${cursores.length}`, numero: cursores.length }],
        `CURSOR_${cursores.length}`
      )
    },
  })

  const avisos: number[] = []
  const itens = await client.listarItensDoQuadro('PVT_1', {
    onTruncado: (lidos) => avisos.push(lidos),
  })

  // Para no teto em vez de girar para sempre...
  expect(cursores).toHaveLength(PAGINAS_ATE_O_TETO)
  expect(cursores[0]).toBeNull()
  expect(cursores[1]).toBe('CURSOR_1')
  expect(cursores[PAGINAS_ATE_O_TETO - 1]).toBe(`CURSOR_${PAGINAS_ATE_O_TETO - 1}`)
  expect(itens).toHaveLength(PAGINAS_ATE_O_TETO)
  // ...e avisa UMA vez, com o número exato do que conseguiu ler. Truncar em
  // silêncio recriaria o defeito que a paginação veio consertar.
  expect(avisos).toEqual([PAGINAS_ATE_O_TETO])
})

test('listarItensDoQuadro NÃO avisa quando o quadro acaba na última página permitida', async () => {
  // O vizinho de porta do caso acima: mesmas 20 páginas, mesmos 20 itens, só
  // que a última diz que não há próxima. O quadro acabou, não foi cortado.
  let paginas = 0
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () => {
      paginas++
      const ultima = paginas === PAGINAS_ATE_O_TETO
      return paginaDeItens(
        [{ id: `PVTI_${paginas}`, numero: paginas }],
        ultima ? null : `CURSOR_${paginas}`
      )
    },
  })

  const avisos: number[] = []
  const itens = await client.listarItensDoQuadro('PVT_1', {
    onTruncado: (lidos) => avisos.push(lidos),
  })

  expect(paginas).toBe(PAGINAS_ATE_O_TETO)
  expect(itens).toHaveLength(PAGINAS_ATE_O_TETO)
  // Alarme falso aqui é pior que nenhum alarme: treina quem chama a ignorar
  // o aviso do dia em que a leitura de verdade for cortada.
  expect(avisos).toEqual([])
})

// ---------------------------------------------------------------------------
// L3-T8 — o campo NUMBER "Peso" no quadro.
//
// Toda mutation abaixo foi conferida contra a API REAL do GitHub em
// 31/08/2026 (quadro descartável PVT_kwHODEJV384BiCgy, criado e apagado):
//   - introspection: ProjectV2CustomFieldType tem NUMBER; CreateProjectV2FieldInput
//     pede só { projectId, dataType, name } — NUMBER não leva configuração;
//   - ProjectV2FieldValue.number é Float;
//   - criar duas vezes o mesmo nome responde "Name has already been taken"
//     (o MESMO laço eterno que o campo Sprint já produziu — por isso a leitura
//     vem antes da criação, e o homônimo de outro tipo é erro à parte).
// Este arquivo já carrega a cicatriz de `criarCampoDeIteracao`, que passou
// verde contra um fake permissivo enquanto a API real recusava a chamada.

test('getNumberField acha o campo NUMBER pelo nome e devolve o id', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () => ({
      data: {
        node: {
          fields: {
            nodes: [
              { __typename: 'ProjectV2Field', id: 'F_title', name: 'Title', dataType: 'TITLE' },
              { __typename: 'ProjectV2Field', id: 'F_peso', name: 'Peso', dataType: 'NUMBER' },
            ],
          },
        },
      },
    }),
  })

  const campo = await client.getNumberField({ projectId: 'PVT_1', fieldName: 'Peso' })
  expect(campo).toEqual({ fieldId: 'F_peso' })
})

test('campo Peso ausente lança o erro TIPADO — quem chama resolve criando', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () => ({
      data: {
        node: {
          fields: {
            nodes: [
              { __typename: 'ProjectV2Field', id: 'F_title', name: 'Title', dataType: 'TITLE' },
            ],
          },
        },
      },
    }),
  })

  await expect(
    client.getNumberField({ projectId: 'PVT_1', fieldName: 'Peso' })
  ).rejects.toBeInstanceOf(CampoNumericoAusenteError)
})

test('homônimo de OUTRO tipo não é ausência: erro de conflito, não tentativa de criar', async () => {
  // Sem esta separação o produto tentaria criar "Peso" a cada tique e o GitHub
  // responderia "Name has already been taken" para sempre — provado ao vivo.
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () => ({
      data: {
        node: {
          fields: {
            nodes: [{ __typename: 'ProjectV2Field', id: 'F_peso', name: 'Peso', dataType: 'TEXT' }],
          },
        },
      },
    }),
  })

  await expect(
    client.getNumberField({ projectId: 'PVT_1', fieldName: 'Peso' })
  ).rejects.toBeInstanceOf(NomeDeCampoEmConflitoError)
})

test('criarCampoNumerico manda dataType NUMBER e devolve o campo criado', async () => {
  const calls: GraphQLRequest[] = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return { data: { createProjectV2Field: { projectV2Field: { id: 'F_novo', name: 'Peso' } } } }
    },
  })

  const campo = await client.criarCampoNumerico({ projectId: 'PVT_1', fieldName: 'Peso' })

  expect(campo).toEqual({ fieldId: 'F_novo', name: 'Peso' })
  expect(calls[0]?.variables).toEqual({ projectId: 'PVT_1', name: 'Peso' })
  // Sem `dataType: NUMBER` o GitHub cria um campo de TEXTO chamado "Peso":
  // parece certo na tela e não ordena, não soma, não filtra por tamanho.
  expect(calls[0]?.query).toContain('dataType: NUMBER')
  // NUMBER não leva `iterationConfiguration` nem `singleSelectOptions`
  // (CreateProjectV2FieldInput, introspection de 31/08).
  expect(calls[0]?.query).not.toContain('iterationConfiguration')
  expect(calls[0]?.query).not.toContain('singleSelectOptions')
})

test('setNumberField manda o valor como number — o único aceito pelo campo NUMBER', async () => {
  const calls: GraphQLRequest[] = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_1' } } } }
    },
  })

  const itemId = await client.setNumberField({
    projectId: 'PVT_1',
    itemId: 'PVTI_1',
    fieldId: 'F_peso',
    number: 8,
  })

  expect(itemId).toBe('PVTI_1')
  expect(calls[0]?.variables).toEqual({
    projectId: 'PVT_1',
    itemId: 'PVTI_1',
    fieldId: 'F_peso',
    number: 8,
  })
  // `value: { number: $number }` — mandar `text` aqui grava o campo errado ou
  // é recusado; ProjectV2FieldValue.number é Float (introspection de 31/08).
  expect(calls[0]?.query).toContain('value: { number: $number }')
  expect(calls[0]?.query).toContain('$number: Float!')
})

test('erro do GraphQL ao criar o campo Peso SOBE — não vira sucesso silencioso', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () => ({ errors: [{ message: 'Name has already been taken' }] }),
  })

  await expect(
    client.criarCampoNumerico({ projectId: 'PVT_1', fieldName: 'Peso' })
  ).rejects.toThrow('Name has already been taken')
})

// ---------------------------------------------------------------------------
// O que a listagem precisa carregar para o desempate existir. Sem estes dois
// números, `decidirQuadro` recebe quatro quadros ligados indistinguíveis e
// devolve "escolher" — que foi exatamente o que travou o repositório do dono.
// A forma da query foi conferida contra a API de produção em 31/08.
// ---------------------------------------------------------------------------
test('a listagem traz itens e campos de cada quadro — o desempate depende deles', async () => {
  const calls: GraphQLRequest[] = []
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async (request) => {
      calls.push(request)
      return {
        data: {
          repository: {
            projectsV2: {
              nodes: [
                {
                  id: 'PVT_kwHODEJV384BTtgW',
                  number: 3,
                  title: 'Jardim das Patinhas',
                  closed: false,
                  items: { totalCount: 146 },
                  fields: { totalCount: 24 },
                },
                {
                  id: 'PVT_kwHODEJV384Bh9VK',
                  number: 11,
                  title: 'loureng/patinhas-3d-crafts',
                  closed: false,
                  items: { totalCount: 0 },
                  fields: { totalCount: 13 },
                },
              ],
            },
          },
        },
      }
    },
  })

  const quadros = await client.listarQuadrosDoRepositorio({
    owner: 'loureng',
    repo: 'patinhas-3d-crafts',
  })

  expect(quadros).toEqual([
    {
      id: 'PVT_kwHODEJV384BTtgW',
      number: 3,
      title: 'Jardim das Patinhas',
      closed: false,
      itensCount: 146,
      camposCount: 24,
    },
    {
      id: 'PVT_kwHODEJV384Bh9VK',
      number: 11,
      title: 'loureng/patinhas-3d-crafts',
      closed: false,
      itensCount: 0,
      camposCount: 13,
    },
  ])
  // A query TEM que pedir os dois totais — sem isso o campo chega sempre zero e
  // o desempate volta a ver empate onde não há.
  expect(calls[0]?.query).toMatch(/items\(first: 1\)\s*\{\s*totalCount\s*\}/)
  expect(calls[0]?.query).toMatch(/fields\(first: 1\)\s*\{\s*totalCount\s*\}/)
})
