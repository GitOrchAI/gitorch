import { describe, it, expect, vi } from 'vitest'
import { createGithubBacklog } from './github-backlog.js'

// D12 — PROVADO AO VIVO em 01/09/2026 contra loureng/patinhas-3d-crafts (conta
// PESSOAL): o token do GitHub App (`mintInstallationToken`, usado por
// `railsToken` em scheduler.ts) devolve "Resource not accessible by
// integration" em TODA mutation de Projects V2 (addProjectV2ItemById) e nem
// sequer ENXERGA o board na leitura (getProjectId) — o mesmo limite que
// `garantir-sprint-dos-projetos.ts` já documentava para a passada de sprint,
// só que o caminho do PO (backlog-executor -> github-backlog) nunca ganhou o
// mesmo tratamento. O REST (criar issue, sub-issue, label, milestone)
// continua funcionando com o token do App nos dois tipos de conta — só
// Projects V2 é cego em conta pessoal.
//
// O board do cliente (`GITORCH_PROJECT_BOARD`) foi apontado hoje para
// loureng/3 (D11) — uma conta pessoal. Sem este `boardToken`, TODA missão do
// PO para o Jardim das Patinhas quebra em `getProjectId` antes de criar
// qualquer issue nova: uma regressão pior que o silêncio anterior.
//
// `boardToken` é o campo que resolve isso: quando presente, TODA chamada ao
// Projects V2 (addItemById via addToBoard, setStatus, e por extensão
// setSprint/setWeight/postSprintGoal que passam pelo MESMO ProjectV2Client)
// usa ele; REST (createIssue, addSubIssue, addLabels) continua usando
// `token` — a identidade do produto, sem mudar autoria das issues.

/** Fetch de mentira que devolve, por chamada, QUAL Authorization chegou. */
function githubComEspiaDeToken() {
  const autorizacoes: Array<{ tipo: 'rest' | 'graphql'; authorization: string | null }> = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const endereco = String(url)
    const headers = new Headers(init?.headers)
    const authorization = headers.get('authorization')
    const tipo = endereco.includes('/graphql') ? 'graphql' : 'rest'
    autorizacoes.push({ tipo, authorization })

    if (tipo === 'graphql') {
      return new Response(
        JSON.stringify({ data: { addProjectV2ItemById: { item: { id: 'PVTI_novo' } } } }),
        { status: 200 }
      )
    }
    return new Response(JSON.stringify({ number: 1, node_id: 'I_1' }), { status: 201 })
  })
  return { autorizacoes, fetchImpl: fetchImpl as unknown as typeof fetch }
}

describe('boardToken — a credencial que alcança Projects V2 em conta pessoal', () => {
  it('addToBoard usa boardToken, nunca token, quando os dois estão presentes', async () => {
    const { autorizacoes, fetchImpl } = githubComEspiaDeToken()
    const backlog = createGithubBacklog({
      token: 'token-do-app',
      boardToken: 'token-do-cliente',
      repository: 'loureng/patinhas-3d-crafts',
      projectId: 'PVT_board',
      fetchImpl,
    })

    const itemId = await backlog.addToBoard('I_1')

    expect(itemId).toBe('PVTI_novo')
    const graphql = autorizacoes.filter((a) => a.tipo === 'graphql')
    expect(graphql.length).toBeGreaterThan(0)
    expect(graphql.every((a) => a.authorization === 'Bearer token-do-cliente')).toBe(true)
  })

  it('createIssue continua com token (identidade do produto), não boardToken', async () => {
    const { autorizacoes, fetchImpl } = githubComEspiaDeToken()
    const backlog = createGithubBacklog({
      token: 'token-do-app',
      boardToken: 'token-do-cliente',
      repository: 'loureng/patinhas-3d-crafts',
      projectId: 'PVT_board',
      fetchImpl,
    })

    await backlog.createIssue({ title: 't', body: 'b' })

    const rest = autorizacoes.filter((a) => a.tipo === 'rest')
    expect(rest.length).toBeGreaterThan(0)
    expect(rest.every((a) => a.authorization === 'token token-do-app')).toBe(true)
  })

  it('sem boardToken, cai no token — comportamento de sempre preservado', async () => {
    const { autorizacoes, fetchImpl } = githubComEspiaDeToken()
    const backlog = createGithubBacklog({
      token: 'token-do-app',
      repository: 'loureng/patinhas-3d-crafts',
      projectId: 'PVT_board',
      fetchImpl,
    })

    await backlog.addToBoard('I_1')

    const graphql = autorizacoes.filter((a) => a.tipo === 'graphql')
    expect(graphql.every((a) => a.authorization === 'Bearer token-do-app')).toBe(true)
  })
})

describe('addToBoard — idempotência (item já no quadro não vira duplicata)', () => {
  it('"Content already exists" resolve o id do item existente, sem lançar', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const endereco = String(url)
      const corpo = typeof init?.body === 'string' ? init.body : ''
      if (endereco.includes('/graphql') && corpo.includes('addProjectV2ItemById')) {
        return new Response(
          JSON.stringify({
            errors: [{ message: 'Content already exists in this project', type: 'UNPROCESSABLE' }],
          }),
          { status: 200 }
        )
      }
      if (endereco.includes('/graphql') && corpo.includes('projectItems')) {
        return new Response(
          JSON.stringify({
            data: {
              node: {
                projectItems: {
                  nodes: [
                    { id: 'PVTI_ja_existia', project: { id: 'PVT_board' } },
                    { id: 'PVTI_de_outro_quadro', project: { id: 'PVT_outro' } },
                  ],
                },
              },
            },
          }),
          { status: 200 }
        )
      }
      return new Response(JSON.stringify({ number: 1, node_id: 'I_1' }), { status: 201 })
    }) as unknown as typeof fetch

    const backlog = createGithubBacklog({
      token: 't',
      repository: 'dono/repo',
      projectId: 'PVT_board',
      fetchImpl,
    })

    await expect(backlog.addToBoard('I_1')).resolves.toBe('PVTI_ja_existia')
  })

  it('chamar addToBoard duas vezes para a MESMA issue não duplica o card', async () => {
    let chamadasDeAdd = 0
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const endereco = String(url)
      const corpo = typeof init?.body === 'string' ? init.body : ''
      if (endereco.includes('/graphql') && corpo.includes('addProjectV2ItemById')) {
        chamadasDeAdd += 1
        if (chamadasDeAdd === 1) {
          return new Response(
            JSON.stringify({ data: { addProjectV2ItemById: { item: { id: 'PVTI_1' } } } }),
            { status: 200 }
          )
        }
        return new Response(
          JSON.stringify({ errors: [{ message: 'Content already exists in this project' }] }),
          { status: 200 }
        )
      }
      if (endereco.includes('/graphql') && corpo.includes('projectItems')) {
        return new Response(
          JSON.stringify({
            data: {
              node: { projectItems: { nodes: [{ id: 'PVTI_1', project: { id: 'PVT_board' } }] } },
            },
          }),
          { status: 200 }
        )
      }
      return new Response(JSON.stringify({ number: 1, node_id: 'I_1' }), { status: 201 })
    }) as unknown as typeof fetch

    const backlog = createGithubBacklog({
      token: 't',
      repository: 'dono/repo',
      projectId: 'PVT_board',
      fetchImpl,
    })

    const primeiro = await backlog.addToBoard('I_1')
    const segundo = await backlog.addToBoard('I_1')

    expect(primeiro).toBe('PVTI_1')
    expect(segundo).toBe('PVTI_1')
  })
})
