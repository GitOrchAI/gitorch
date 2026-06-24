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

test('surfaces GitHub GraphQL errors with actionable messages', async () => {
  const client = new ProjectV2Client({
    token: 'test-token',
    request: async () => ({ errors: [{ message: 'Project not found' }] }),
  })

  await expect(client.archiveItem({ projectId: 'PVT_1', itemId: 'PVTI_1' })).rejects.toThrow(
    'GitHub GraphQL request failed: Project not found'
  )
})
