import { describe, it, expect, vi } from 'vitest'
import { runPoMissionViaRails } from './po-rails-mission.js'
import { FREE_TEXT_OPTION_VALUE } from './telegram-bot.js'

const PO_REPLIES: Record<string, string> = {
  phases:
    '{"phases":[{"title":"Fase 1","goal":"g","rationale":"r","usableOutcome":"O dono conclui o fluxo ponta a ponta."}]}',
  epics: '{"epics":[{"phaseIndex":0,"title":"Épico A","description":"d","journeyIndexes":[]}]}',
  features: '{"features":[{"epicIndex":0,"title":"[Feature] F","description":"d"}]}',
  tasks: JSON.stringify({
    tasks: [
      {
        featureIndex: 0,
        weight: 2,
        weightRationale: 'Mudança pequena, padrão conhecido.',
        fields: {
          titulo: '[Task] t',
          goal: 'g',
          taskDetails: 'td',
          taskDescription: 'd',
          implementationGuide: '1;2;3',
          // D5: precisa ser um critério REAL (não "c1"/"c2" de preenchimento)
          // para passar na quarta pergunta da régua — "tem como testar?".
          verificationCriteria: '- GET /o/r retorna 200\n- teste automatizado passa verde',
          dependencies: 'nenhuma',
          relatedFiles: 'f.ts',
          notes: 'n',
        },
      },
    ],
  }),
  roadmap: '{"sprintGoal":"G","assignments":[{"taskIndex":0,"sprint":1}]}',
}

// fetch fake: wish aberta + GraphQL de projeto/board + REST de issues.
//
// `pesoNoQuadro` (L3-T8) é o estado do campo numérico "Peso" do card, para a
// missão inteira poder ser conferida pelo RESULTADO: o peso que a LLM
// preencheu no formulário tem que sair do outro lado gravado no quadro.
function fakeFetch(pesoNoQuadro?: Map<string, number>): typeof fetch {
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
        return json({
          data: { repositoryOwner: { __typename: 'User', projectV2: { id: 'PVT_board' } } },
        })
      }
      if (q.includes('GetProjectId')) {
        return json({
          data: { repositoryOwner: { __typename: 'User', projectV2: { id: 'PVT_board' } } },
        })
      }
      if (q.includes('addSubIssue')) return json({ data: { addSubIssue: { issue: { id: 'x' } } } })
      if (q.includes('createProjectV2StatusUpdate')) {
        return json({ data: { createProjectV2StatusUpdate: { statusUpdate: { id: 'SU_1' } } } })
      }
      if (q.includes('addProjectV2ItemById')) {
        return json({ data: { addProjectV2ItemById: { item: { id: 'PVTI_1' } } } })
      }
      // L3-T8: o quadro deste fake nasce SEM o campo "Peso" — o caminho que
      // o cliente real percorre na primeira vez.
      if (q.includes('GetNumberField')) {
        return json({ data: { node: { fields: { nodes: [] } } } })
      }
      if (q.includes('CriarCampoNumerico')) {
        return json({
          data: { createProjectV2Field: { projectV2Field: { id: 'F_peso', name: 'Peso' } } },
        })
      }
      if (q.includes('SetProjectV2Number')) {
        const v = (body.variables ?? {}) as { itemId?: string; number?: number }
        pesoNoQuadro?.set(String(v.itemId), Number(v.number))
        return json({
          data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: String(v.itemId) } } },
        })
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

  it('sem wish aberta: a pergunta ao dono tem as 3 opções fechadas + a 4ª livre (feedback do dono: "a 4ª resposta tem que ser manual")', async () => {
    const f = (async () => new Response(JSON.stringify([]), { status: 200 })) as typeof fetch
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const askCalls: any[] = []
    const agentQuestionService = {
      ask: async (userId: string, projectId: string, input: any) => {
        askCalls.push({ userId, projectId, input })
        return { deduped: false, question: { id: 'q_1' } }
      },
    }

    const r = await runPoMissionViaRails({
      repository: 'o/r',
      board: 'o/9',
      githubToken: 't',
      execute: async () => '{}',
      contextBlocks: [],
      fetchImpl: f,
      projectId: 'proj_1',
      userId: 'user_1',
      agentQuestionService: agentQuestionService as any,
    })

    expect(r.exitCode).toBe(0)
    expect(askCalls).toHaveLength(1)
    const options = askCalls[0].input.options
    expect(options).toHaveLength(4)
    // as 3 fechadas continuam lá, na mesma ordem de sempre.
    expect(options.slice(0, 3).map((o: any) => o.value)).toEqual([
      'wishlist-mvp-features',
      'wishlist-technical-health',
      'wishlist-ui-design',
    ])
    // a 4ª é o escape hatch de texto livre — nunca um 4º valor fechado.
    expect(options[3].value).toBe(FREE_TEXT_OPTION_VALUE)
    expect(options[3].label).toContain('Outro')
  })

  it('tria incidente sem prioridade: label P0 + comentário + liberado ganha gitorch:task e milestone', async () => {
    const actions: Array<{ method: string; url: string; body?: unknown }> = []
    const f = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })
      if (method !== 'GET') {
        actions.push({ method, url: u, body: init?.body ? JSON.parse(String(init.body)) : {} })
      }
      if (u.includes('/search/issues') && u.includes('gitorch%3Aincident')) {
        return json({
          items: [
            {
              number: 60,
              title: '[Incident] CI failing on main: Deploy',
              body: 'Evidence...',
              labels: [{ name: 'gitorch:incident' }],
            },
          ],
        })
      }
      if (u.includes('/milestones')) return json([{ number: 7, title: 'Sprint 2' }])
      if (u.includes('/issues?labels=wishlist')) return json([])
      return json({})
    }) as typeof fetch

    const r = await runPoMissionViaRails({
      repository: 'o/r',
      board: 'o/9',
      githubToken: 't',
      contextBlocks: [],
      fetchImpl: f,
      execute: async () =>
        JSON.stringify({ priority: 'P0', rationale: 'main quebrada', releaseNow: true }),
    })

    expect(r.output).toContain('triaged #60: P0 (released)')
    expect(r.noOp).toBe(false)
    const labelPost = actions.find((a) => a.url.includes('/issues/60/labels'))
    expect(labelPost?.body).toEqual({ labels: ['P0', 'gitorch:task'] })
    const comment = actions.find((a) => a.url.includes('/issues/60/comments'))
    expect(JSON.stringify(comment?.body)).toContain('gitorch:triage')
    const milestone = actions.find((a) => a.method === 'PATCH' && a.url.includes('/issues/60'))
    expect(milestone?.body).toEqual({ milestone: 7 })
  })

  it('incidente NÃO liberado: só prioridade e racional, sem furar a sprint', async () => {
    const actions: Array<{ url: string; body?: unknown }> = []
    const f = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })
      if (method !== 'GET')
        actions.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : {} })
      if (u.includes('/search/issues') && u.includes('gitorch%3Aincident')) {
        return json({
          items: [{ number: 61, title: 'x', body: 'y', labels: [{ name: 'gitorch:incident' }] }],
        })
      }
      if (u.includes('/issues?labels=wishlist')) return json([])
      return json({})
    }) as typeof fetch
    await runPoMissionViaRails({
      repository: 'o/r',
      board: 'o/9',
      githubToken: 't',
      contextBlocks: [],
      fetchImpl: f,
      execute: async () =>
        JSON.stringify({ priority: 'P3', rationale: 'baixo impacto', releaseNow: false }),
    })
    const labelPost = actions.find((a) => a.url.includes('/issues/61/labels'))
    expect(labelPost?.body).toEqual({ labels: ['P3'] })
    expect(actions.some((a) => a.url.includes('/milestones'))).toBe(false)
  })

  it('PO ao triar incidente marca a issue como sua (gitorch:agent:po) e tira o agente anterior', async () => {
    const actions: Array<{ method: string; url: string; body?: unknown }> = []
    const f = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })
      if (method !== 'GET') {
        actions.push({ method, url: u, body: init?.body ? JSON.parse(String(init.body)) : {} })
      }
      if (u.includes('/search/issues') && u.includes('gitorch%3Aincident')) {
        return json({
          items: [
            {
              number: 62,
              title: '[Incident] x',
              body: 'y',
              // RA já tinha passado pela issue antes do PO assumir a triagem.
              labels: [{ name: 'gitorch:incident' }, { name: 'gitorch:agent:ra' }],
            },
          ],
        })
      }
      if (u.includes('/issues?labels=wishlist')) return json([])
      return json({})
    }) as typeof fetch

    await runPoMissionViaRails({
      repository: 'o/r',
      board: 'o/9',
      githubToken: 't',
      contextBlocks: [],
      fetchImpl: f,
      execute: async () =>
        JSON.stringify({ priority: 'P2', rationale: 'triagem normal', releaseNow: false }),
    })

    const agentLabelPost = actions.find(
      (a) =>
        a.method === 'POST' &&
        a.url.includes('/issues/62/labels') &&
        JSON.stringify(a.body).includes('gitorch:agent:po')
    )
    expect(agentLabelPost).toBeDefined()

    const removal = actions.find(
      (a) => a.method === 'DELETE' && a.url.includes('/issues/62/labels/')
    )
    expect(removal?.url).toContain(encodeURIComponent('gitorch:agent:ra'))
  })

  it('com wish: roda os 5 passos e aplica a árvore (resumo no output)', async () => {
    const steps: string[] = []
    const pesoNoQuadro = new Map<string, number>()
    const r = await runPoMissionViaRails({
      repository: 'o/r',
      board: 'o/9',
      githubToken: 't',
      contextBlocks: ['ctx'],
      fetchImpl: fakeFetch(pesoNoQuadro),
      execute: async (prompt) => {
        const step = prompt.match(/Step: po-(\w+)/)?.[1] ?? '?'
        steps.push(step)
        return PO_REPLIES[step] ?? '{}'
      },
    })
    expect(steps).toEqual(['phases', 'epics', 'features', 'tasks', 'roadmap'])
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain('wish #42')
    // fase + épico + feature + task = 4 issues
    expect(r.output).toContain('created=4')
    expect(r.output).toContain('Roadmap: 1 sprint(s)')
    // L3-T8, a missão inteira ponta a ponta: o peso 2 que a LLM devolveu no
    // formulário (PO_REPLIES.tasks) saiu gravado no card do quadro. Antes
    // deste trabalho ele morria no tipo do BacklogPlan.
    expect([...pesoNoQuadro.values()]).toEqual([2])
  })
})

describe('teto de tempo (leva D)', () => {
  it('toda chamada ao GitHub (REST direto e via ProjectV2Client) carrega um AbortSignal não abortado', async () => {
    const spy = vi.fn(fakeFetch())
    await runPoMissionViaRails({
      repository: 'o/r',
      board: 'o/9',
      githubToken: 't',
      contextBlocks: ['ctx'],
      fetchImpl: spy as unknown as typeof fetch,
      execute: async (prompt) => {
        const step = prompt.match(/Step: po-(\w+)/)?.[1] ?? '?'
        return PO_REPLIES[step] ?? '{}'
      },
    })
    expect(spy.mock.calls.length).toBeGreaterThan(0)
    for (const call of spy.mock.calls) {
      const init = call[1] as RequestInit | undefined
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(init?.signal?.aborted).toBe(false)
    }
  })
})
