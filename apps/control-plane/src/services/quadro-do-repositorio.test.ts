import { describe, it, expect, vi } from 'vitest'
import {
  resolverQuadroDoRepositorio,
  resolverQuadroParaDesejo,
  anexarIssueDeIncidenteAoQuadro,
  type PrismaLikeParaQuadro,
  type ArgsDeAnexarIncidenteAoQuadro,
} from './quadro-do-repositorio.js'

// L4-T8 (fix-up) — o caminho ÚNICO de "qual quadro (Projects v2) e qual
// credencial este repositório usa", extraído de
// `varrerIssuesForaDoQuadroDosProjetos` (plugins/scheduler.ts) para os 5
// nascimentos de issue que precisam da MESMA resposta: os 4 do desejo
// (routes/index.ts, plugins/telegram.ts, plugins/scheduler.ts×2) e a issue
// de incidente. Nada de resolução nova de credencial — o trio é sempre
// `lerCredencialQueAlcancaOProjeto` + `listarQuadrosDoRepositorio` +
// `decidirQuadro`.

/** Um `fetch` fake que responde ao GraphQL de `listarQuadrosDoRepositorio`. */
function fakeFetchDeQuadros(nodes: Array<Record<string, unknown>>): typeof fetch {
  const impl = vi.fn(async () => {
    return new Response(JSON.stringify({ data: { repository: { projectsV2: { nodes } } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return impl as unknown as typeof fetch
}

function fakePrisma(
  projeto: {
    wingId?: string | null
    userId?: string | null
    encryptedClientToken?: string | null
  } | null
): PrismaLikeParaQuadro {
  return {
    project: {
      findUnique: vi.fn(async () => projeto),
      update: vi.fn(async () => ({})),
    },
  }
}

describe('resolverQuadroDoRepositorio', () => {
  describe('caminho { projectId } — o caso comum, um projeto do GitOrch', () => {
    it("decisão 'usar': devolve { projectId, boardToken }", async () => {
      const prisma = fakePrisma({
        wingId: 'acme/api',
        userId: 'user_1',
        encryptedClientToken: null,
      })
      const getRawGithubToken = vi.fn(async () => 'token-do-login')
      const fetchImpl = fakeFetchDeQuadros([
        { id: 'PVT_1', number: 2, title: 'acme/api', closed: false },
      ])

      const resultado = await resolverQuadroDoRepositorio(
        { projectId: 'proj_1' },
        { prisma, engineConnections: { getRawGithubToken }, fetchImpl }
      )

      expect(resultado.quadro).toEqual({ projectId: 'PVT_1', boardToken: 'token-do-login' })
      expect(resultado.motivo).toBeUndefined()
      expect(getRawGithubToken).toHaveBeenCalledWith('user_1')
    })

    // Achado F (revisão do fix-up 2): antes desta correção,
    // `resolverQuadroDoRepositorio({ projectId })` lia o MESMO projeto do
    // banco DUAS vezes — uma vez aqui (`wingId`/`userId`) e outra vez dentro
    // de `lerCredencialQueAlcancaOProjeto` → `lerCredencialDoProjeto`
    // (`encryptedClientToken`), os dois com `where: { id: projectId }`. Uma
    // leitura só, selecionando os três campos de uma vez, resolve o mesmo
    // resultado sem a consulta repetida.
    it('achado F: resolve quadro e credencial com UMA SÓ leitura do projeto (findUnique), não duas', async () => {
      const prisma = fakePrisma({
        wingId: 'acme/api',
        userId: 'user_1',
        encryptedClientToken: null,
      })
      const getRawGithubToken = vi.fn(async () => 'token-do-login')
      const fetchImpl = fakeFetchDeQuadros([
        { id: 'PVT_1', number: 2, title: 'acme/api', closed: false },
      ])

      const resultado = await resolverQuadroDoRepositorio(
        { projectId: 'proj_1' },
        { prisma, engineConnections: { getRawGithubToken }, fetchImpl }
      )

      expect(resultado.quadro).toEqual({ projectId: 'PVT_1', boardToken: 'token-do-login' })
      expect(prisma.project.findUnique).toHaveBeenCalledTimes(1)
    })

    it('sem quadro nenhum no repositório: devolve null com motivo, nunca lança', async () => {
      const prisma = fakePrisma({
        wingId: 'acme/api',
        userId: 'user_1',
        encryptedClientToken: null,
      })
      const getRawGithubToken = vi.fn(async () => 'token-do-login')
      const fetchImpl = fakeFetchDeQuadros([])

      const resultado = await resolverQuadroDoRepositorio(
        { projectId: 'proj_1' },
        { prisma, engineConnections: { getRawGithubToken }, fetchImpl }
      )

      expect(resultado.quadro).toBeNull()
      expect(resultado.motivo).toBeTruthy()
    })

    it('credencial ausente (sem PAT do projeto e sem login conectado): devolve null, nunca lança', async () => {
      const prisma = fakePrisma({
        wingId: 'acme/api',
        userId: 'user_1',
        encryptedClientToken: null,
      })
      const getRawGithubToken = vi.fn(async () => null)
      const fetchImpl = vi.fn()

      const resultado = await resolverQuadroDoRepositorio(
        { projectId: 'proj_1' },
        {
          prisma,
          engineConnections: { getRawGithubToken },
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }
      )

      expect(resultado.quadro).toBeNull()
      expect(resultado.motivo).toContain('credencial')
      // Sem credencial não há com que listar quadro — a rede nem é tocada.
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('projeto inexistente: devolve null com motivo, nunca lança', async () => {
      const prisma = fakePrisma(null)
      const resultado = await resolverQuadroDoRepositorio(
        { projectId: 'proj_fantasma' },
        { prisma }
      )
      expect(resultado.quadro).toBeNull()
      expect(resultado.motivo).toBeTruthy()
    })

    it('banco fora do ar na leitura do projeto: devolve null, nunca lança', async () => {
      const prisma: PrismaLikeParaQuadro = {
        project: {
          findUnique: vi.fn(async () => {
            throw new Error('ECONNREFUSED')
          }),
          update: vi.fn(),
        },
      }
      const resultado = await resolverQuadroDoRepositorio({ projectId: 'proj_1' }, { prisma })
      expect(resultado.quadro).toBeNull()
      expect(resultado.motivo).toBeTruthy()
    })

    it('GitHub instável ao listar quadros: devolve null com motivo, nunca lança', async () => {
      const prisma = fakePrisma({
        wingId: 'acme/api',
        userId: 'user_1',
        encryptedClientToken: null,
      })
      const getRawGithubToken = vi.fn(async () => 'token-do-login')
      const fetchImpl = vi.fn(async () => {
        throw new Error('fetch failed')
      })

      const resultado = await resolverQuadroDoRepositorio(
        { projectId: 'proj_1' },
        {
          prisma,
          engineConnections: { getRawGithubToken },
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }
      )

      expect(resultado.quadro).toBeNull()
      expect(resultado.motivo).toContain('acme/api')
    })

    it('o `motivo` de erro nunca carrega o token, mesmo quando a leitura do quadro falha', async () => {
      const prisma = fakePrisma({
        wingId: 'acme/api',
        userId: 'user_1',
        encryptedClientToken: null,
      })
      const getRawGithubToken = vi.fn(async () => 'super-secreto')
      const fetchImpl = vi.fn(async () => {
        throw new Error('fetch failed')
      })

      const resultado = await resolverQuadroDoRepositorio(
        { projectId: 'proj_1' },
        {
          prisma,
          engineConnections: { getRawGithubToken },
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }
      )

      expect(resultado.quadro).toBeNull()
      expect(resultado.motivo).not.toContain('super-secreto')
    })
  })

  describe('caminho { repo, token } — repositório sem projeto (ex.: o repo do próprio produto)', () => {
    it("decisão 'usar': devolve { projectId, boardToken } sem tocar o banco", async () => {
      const prisma: PrismaLikeParaQuadro = {
        project: { findUnique: vi.fn(), update: vi.fn() },
      }
      const fetchImpl = fakeFetchDeQuadros([
        { id: 'PVT_9', number: 1, title: 'GitOrchAI/gitorch', closed: false },
      ])

      const resultado = await resolverQuadroDoRepositorio(
        { repo: 'GitOrchAI/gitorch', token: 'token-do-produto' },
        { prisma, fetchImpl }
      )

      expect(resultado.quadro).toEqual({ projectId: 'PVT_9', boardToken: 'token-do-produto' })
      expect(prisma.project.findUnique).not.toHaveBeenCalled()
    })

    it('sem quadro: devolve null com motivo', async () => {
      const prisma: PrismaLikeParaQuadro = {
        project: { findUnique: vi.fn(), update: vi.fn() },
      }
      const fetchImpl = fakeFetchDeQuadros([])

      const resultado = await resolverQuadroDoRepositorio(
        { repo: 'GitOrchAI/gitorch', token: 'token-do-produto' },
        { prisma, fetchImpl }
      )

      expect(resultado.quadro).toBeNull()
      expect(resultado.motivo).toBeTruthy()
    })
  })

  // Os 4 nascimentos de desejo (routes/index.ts, plugins/telegram.ts,
  // plugins/scheduler.ts×2) precisam exatamente disto: um `{projectId,
  // boardToken}` para passar a `criarIssueDeDesejo({ quadro })`, ou
  // `undefined` com um log — nunca uma exceção que derrube a criação da
  // issue.
  describe('resolverQuadroParaDesejo — o atalho comum aos 4 chamadores de criarIssueDeDesejo', () => {
    it("decisão 'usar': devolve { projectId, boardToken }, sem logar nada", async () => {
      const prisma = fakePrisma({
        wingId: 'acme/api',
        userId: 'user_1',
        encryptedClientToken: null,
      })
      const getRawGithubToken = vi.fn(async () => 'token-do-login')
      const fetchImpl = fakeFetchDeQuadros([
        { id: 'PVT_1', number: 2, title: 'acme/api', closed: false },
      ])
      const onInfo = vi.fn()

      const quadro = await resolverQuadroParaDesejo(
        { projectId: 'proj_1', repo: 'acme/api' },
        { prisma, engineConnections: { getRawGithubToken }, fetchImpl, onInfo }
      )

      expect(quadro).toEqual({ projectId: 'PVT_1', boardToken: 'token-do-login' })
      expect(onInfo).not.toHaveBeenCalled()
    })

    it('sem decisão usar: devolve undefined e loga "quadro não decidido para <repo>: <motivo>" — nunca lança', async () => {
      const prisma = fakePrisma({
        wingId: 'acme/api',
        userId: 'user_1',
        encryptedClientToken: null,
      })
      const getRawGithubToken = vi.fn(async () => null)
      const onInfo = vi.fn()

      const quadro = await resolverQuadroParaDesejo(
        { projectId: 'proj_1', repo: 'acme/api' },
        { prisma, engineConnections: { getRawGithubToken }, onInfo }
      )

      expect(quadro).toBeUndefined()
      expect(onInfo).toHaveBeenCalledTimes(1)
      const [mensagem] = onInfo.mock.calls[0] as [string]
      expect(mensagem).toContain('quadro não decidido para acme/api')
      expect(mensagem).toContain('credencial')
    })

    it('sem `onInfo` injetado, não lança — best-effort de verdade', async () => {
      const prisma = fakePrisma({
        wingId: 'acme/api',
        userId: 'user_1',
        encryptedClientToken: null,
      })
      const getRawGithubToken = vi.fn(async () => null)

      await expect(
        resolverQuadroParaDesejo(
          { projectId: 'proj_1', repo: 'acme/api' },
          { prisma, engineConnections: { getRawGithubToken } }
        )
      ).resolves.toBeUndefined()
    })
  })

  // L4-T8 (fix-up) — o `ghIssue` do incidente (plugins/scheduler.ts) usa
  // isto: depois de criar a issue (cliente OU repo do produto), anexa ao
  // quadro pelo `node_id` que a própria criação já devolveu, best-effort —
  // NUNCA desfaz a issue já criada.
  describe('anexarIssueDeIncidenteAoQuadro', () => {
    /** Um `fetch` fake que atende tanto `listarQuadrosDoRepositorio` quanto
     *  `addProjectV2ItemById` — os dois batem no mesmo `/graphql`. */
    function fakeFetchDoGraphql(opts: {
      nodes: Array<Record<string, unknown>>
      addItemById?: () => Response | Promise<Response>
    }) {
      const chamadas: Array<{ url: string; query: string }> = []
      const impl = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const corpo = JSON.parse(String(init?.body ?? '{}')) as { query?: string }
        chamadas.push({ url: String(url), query: corpo.query ?? '' })
        if (corpo.query?.includes('ListarQuadrosDoRepositorio')) {
          return new Response(
            JSON.stringify({ data: { repository: { projectsV2: { nodes: opts.nodes } } } }),
            { status: 200 }
          )
        }
        if (corpo.query?.includes('AddProjectV2ItemById')) {
          if (opts.addItemById) return opts.addItemById()
          return new Response(
            JSON.stringify({ data: { addProjectV2ItemById: { item: { id: 'ITEM_1' } } } }),
            { status: 200 }
          )
        }
        throw new Error(`query inesperada no teste: ${corpo.query}`)
      })
      return { impl: impl as unknown as typeof fetch, chamadas }
    }

    it('repo do CLIENTE com quadro decidido: anexa via o fetch de escrita do cliente', async () => {
      const prisma = fakePrisma({
        wingId: 'acme/api',
        userId: 'user_1',
        encryptedClientToken: null,
      })
      const getRawGithubToken = vi.fn(async () => 'token-do-login')
      const { impl, chamadas } = fakeFetchDoGraphql({
        nodes: [{ id: 'PVT_1', number: 2, title: 'acme/api', closed: false }],
      })
      const fetchDeEscritaNoProduto = vi.fn()

      await anexarIssueDeIncidenteAoQuadro(
        {
          repo: 'acme/api',
          issueNodeId: 'ISSUE_NODE',
          issueNumber: 42,
          ehORepoDoProduto: false,
          projectId: 'proj_1',
        },
        {
          prisma,
          engineConnections: { getRawGithubToken },
          fetchImpl: impl,
          fetchDeEscritaNoCliente: impl,
          fetchDeEscritaNoProduto: fetchDeEscritaNoProduto as unknown as typeof fetch,
        }
      )

      expect(chamadas.some((c) => c.query.includes('AddProjectV2ItemById'))).toBe(true)
      expect(fetchDeEscritaNoProduto).not.toHaveBeenCalled()
    })

    it('repo do PRODUTO com quadro decidido: anexa via o fetch de escrita do produto, sem tocar o banco', async () => {
      const prisma: PrismaLikeParaQuadro = { project: { findUnique: vi.fn(), update: vi.fn() } }
      const { impl, chamadas } = fakeFetchDoGraphql({
        nodes: [{ id: 'PVT_9', number: 1, title: 'GitOrchAI/gitorch', closed: false }],
      })

      await anexarIssueDeIncidenteAoQuadro(
        {
          repo: 'GitOrchAI/gitorch',
          issueNodeId: 'ISSUE_NODE',
          issueNumber: 7,
          ehORepoDoProduto: true,
          token: 'token-do-produto',
        },
        {
          prisma,
          fetchImpl: impl,
          fetchDeEscritaNoCliente: vi.fn() as unknown as typeof fetch,
          fetchDeEscritaNoProduto: impl,
        }
      )

      expect(chamadas.some((c) => c.query.includes('AddProjectV2ItemById'))).toBe(true)
      expect(prisma.project.findUnique).not.toHaveBeenCalled()
    })

    it('sem quadro decidido: não tenta anexar, avisa por onInfo, nunca lança', async () => {
      const prisma = fakePrisma({
        wingId: 'acme/api',
        userId: 'user_1',
        encryptedClientToken: null,
      })
      const getRawGithubToken = vi.fn(async () => 'token-do-login')
      const { impl, chamadas } = fakeFetchDoGraphql({ nodes: [] })
      const onInfo = vi.fn()

      await anexarIssueDeIncidenteAoQuadro(
        {
          repo: 'acme/api',
          issueNodeId: 'ISSUE_NODE',
          issueNumber: 42,
          ehORepoDoProduto: false,
          projectId: 'proj_1',
        },
        {
          prisma,
          engineConnections: { getRawGithubToken },
          fetchImpl: impl,
          fetchDeEscritaNoCliente: impl,
          fetchDeEscritaNoProduto: vi.fn() as unknown as typeof fetch,
          onInfo,
        }
      )

      expect(chamadas.some((c) => c.query.includes('AddProjectV2ItemById'))).toBe(false)
      expect(onInfo).toHaveBeenCalledTimes(1)
      expect(onInfo.mock.calls[0]?.[0]).toContain('acme/api')
    })

    it('falha ao anexar NUNCA lança — só avisa por onWarn com o número da issue e o repo', async () => {
      const prisma = fakePrisma({
        wingId: 'acme/api',
        userId: 'user_1',
        encryptedClientToken: null,
      })
      const getRawGithubToken = vi.fn(async () => 'token-do-login')
      const { impl } = fakeFetchDoGraphql({
        nodes: [{ id: 'PVT_1', number: 2, title: 'acme/api', closed: false }],
        addItemById: () =>
          new Response(JSON.stringify({ errors: [{ message: 'boom de rede' }] }), { status: 200 }),
      })
      const onWarn = vi.fn()

      await expect(
        anexarIssueDeIncidenteAoQuadro(
          {
            repo: 'acme/api',
            issueNodeId: 'ISSUE_NODE',
            issueNumber: 88,
            ehORepoDoProduto: false,
            projectId: 'proj_1',
          },
          {
            prisma,
            engineConnections: { getRawGithubToken },
            fetchImpl: impl,
            fetchDeEscritaNoCliente: impl,
            fetchDeEscritaNoProduto: vi.fn() as unknown as typeof fetch,
            onWarn,
          }
        )
      ).resolves.toBeUndefined()

      expect(onWarn).toHaveBeenCalledTimes(1)
      const [mensagem] = onWarn.mock.calls[0] as [string, unknown]
      expect(mensagem).toContain('88')
      expect(mensagem).toContain('acme/api')
    })

    // Achado E (revisão do fix-up 2): a união discriminada recusa, em TEMPO
    // DE COMPILAÇÃO, a combinação que antes caía num fallback silencioso
    // (`ehORepoDoProduto: false` sem `projectId` era tratado como se fosse
    // `{ repo, token }`, tentando o quadro do repo do PRODUTO com a
    // credencial do incidente do CLIENTE). Não é um teste de comportamento
    // em runtime — é a prova de que o `tsc` do build barra a forma inválida
    // antes de ela existir. `pnpm --filter @gitorch/control-plane build`
    // falharia se faltasse o `@ts-expect-error` OU se ele estivesse sobrando
    // (TS2578, "Unused '@ts-expect-error' directive").
    it('tipo: ehORepoDoProduto:false SEM projectId não compila — sem fallback para {repo,token}', () => {
      // @ts-expect-error — projectId é obrigatório quando ehORepoDoProduto é false.
      const semProjectId: ArgsDeAnexarIncidenteAoQuadro = {
        repo: 'acme/api',
        issueNodeId: 'X',
        issueNumber: 1,
        ehORepoDoProduto: false,
      }
      const comTokenIndevido: ArgsDeAnexarIncidenteAoQuadro = {
        repo: 'acme/api',
        issueNodeId: 'X',
        issueNumber: 1,
        ehORepoDoProduto: false,
        projectId: 'proj_1',
        // @ts-expect-error — token não existe no ramo ehORepoDoProduto:false.
        token: 'não deveria compilar aqui',
      }
      void semProjectId
      void comTokenIndevido
    })
  })
})
