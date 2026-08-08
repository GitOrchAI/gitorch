import { expect, test } from 'vitest'

import { ProjectV2Client, type GraphQLRequest } from './project-v2-client'

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

  expect(quadros).toEqual([
    { id: 'PVT_a', number: 2, title: 'dono/repo' },
    { id: 'PVT_b', number: 9, title: 'Outro quadro' },
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
