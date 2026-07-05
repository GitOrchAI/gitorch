import { describe, it, expect } from 'vitest'
import { runPoMissionViaRails } from './po-rails-mission.js'

const PO_REPLIES: Record<string, string> = {
  phases: '{"phases":[{"title":"Fase 1","goal":"g","rationale":"r"}]}',
  epics: '{"epics":[{"phaseIndex":0,"title":"Épico A","description":"d"}]}',
  backlog: JSON.stringify({
    items: [
      {
        epicIndex: 0,
        kind: 'task',
        fields: {
          titulo: '[Task] t',
          description: 'd',
          notes: 'n',
          implementationGuide: '1;2;3',
          verificationCriteria: '- c1\n- c2',
          summary: 's',
          analysisResult: 'a',
          relatedFiles: 'f.ts',
        },
      },
    ],
  }),
  sprint: '{"sprintGoal":"G","selectedItemIndexes":[0]}',
}

// fetch fake: wish aberta + GraphQL de projeto/board + REST de issues.
function fakeFetch(): typeof fetch {
  let issueN = 500
  return (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const u = String(url)
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })

    if (u.includes('/issues?labels=wishlist')) {
      return json([{ number: 42, node_id: 'I_wish42', title: 'Wish', body: 'b' }])
    }
    if (u.includes('/search/issues')) return json({ items: [] })
    if (u.endsWith('/issues') && init?.method === 'POST') {
      issueN += 1
      return json({ number: issueN, node_id: `I_${issueN}` })
    }
    if (u.includes('/graphql')) {
      const q = String(body.query ?? '')
      if (q.includes('projectV2(number:') || q.includes('projectV2(number :')) {
        return json({ data: { user: { projectV2: { id: 'PVT_board' } } } })
      }
      if (q.includes('GetProjectId')) {
        return json({ data: { user: { projectV2: { id: 'PVT_board' } } } })
      }
      if (q.includes('addSubIssue')) return json({ data: { addSubIssue: { issue: { id: 'x' } } } })
      if (q.includes('createProjectV2StatusUpdate')) {
        return json({ data: { createProjectV2StatusUpdate: { statusUpdate: { id: 'SU_1' } } } })
      }
      if (q.includes('addProjectV2ItemById')) {
        return json({ data: { addProjectV2ItemById: { item: { id: 'PVTI_1' } } } })
      }
      if (q.includes('GetIterationField')) {
        return json({ data: { node: { fields: { nodes: [] } } } })
      }
      if (q.includes('projectItems')) {
        return json({ data: { node: { projectItems: { nodes: [] } } } })
      }
      // labels via node -> number
      if (q.includes('nameWithOwner')) {
        return json({
          data: { node: { number: issueN, repository: { nameWithOwner: 'o/r' } } },
        })
      }
      return json({ data: {} })
    }
    if (u.includes('/labels') && init?.method === 'POST') return json([])
    return json({})
  }) as typeof fetch
}

describe('runPoMissionViaRails', () => {
  it('sem wish aberta: encerra limpo sem planejar', async () => {
    const f = (async () => new Response(JSON.stringify([]), { status: 200 })) as typeof fetch
    const r = await runPoMissionViaRails({
      repository: 'o/r',
      board: 'o/9',
      githubToken: 't',
      execute: async () => '{}',
      contextBlocks: [],
      fetchImpl: f,
    })
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain('no open wishlist')
  })

  it('com wish: roda os 4 passos e aplica a árvore (resumo no output)', async () => {
    const steps: string[] = []
    const r = await runPoMissionViaRails({
      repository: 'o/r',
      board: 'o/9',
      githubToken: 't',
      contextBlocks: ['ctx'],
      fetchImpl: fakeFetch(),
      execute: async (prompt) => {
        const step = prompt.match(/Step: po-(\w+)/)?.[1] ?? '?'
        steps.push(step)
        return PO_REPLIES[step] ?? '{}'
      },
    })
    expect(steps).toEqual(['phases', 'epics', 'backlog', 'sprint'])
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain('wish #42')
    expect(r.output).toContain('created=3')
  })
})
