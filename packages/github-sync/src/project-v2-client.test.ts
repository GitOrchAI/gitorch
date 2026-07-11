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

  const id = await client.getProjectId({ login: 'loureng', number: 3, ownerType: 'user' })

  expect(id).toBe('PVT_user_1')
  expect(calls[0].variables).toEqual({ login: 'loureng', number: 3 })
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

  const id = await client.findProjectId({ login: 'loureng', number: 3, ownerType: 'user' })
  expect(id).toBe('PVT_found')
})

test('findProjectId returns null (does NOT throw) when the board is absent', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    // Dono existe, mas não tem o Project v2 #N — o resolver da coleta de
    // contexto trata isso como "criar", não como erro.
    request: async () => ({ data: { user: { projectV2: null } } }),
  })

  const id = await client.findProjectId({ login: 'loureng', number: 99, ownerType: 'user' })
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
