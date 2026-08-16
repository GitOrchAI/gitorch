import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import { generateKeyPairSync } from 'node:crypto'
import { setupRoutes } from './setup.js'
import type { EngineConnectionService } from '../services/engine-connection.js'
import { resetAppTokenCache } from '../services/github-app-token.js'

/**
 * O ATAQUE que estes testes fecham: o wizard aceitava, no passo final, QUALQUER
 * texto no campo de repositórios. Quem entrasse no produto de forma legítima
 * (conta criada, GitHub conectado, um motor ligado) podia declarar o repositório
 * de OUTRO cliente — nenhuma das validações que existiam (lista não-vazia, dono
 * resolvível, teto do plano, motor conectado) perguntava de QUEM é o
 * repositório. O projeto nascia com o endereço alheio gravado, e daí em diante
 * o produto resolvia a instalação do GitHub PELO REPOSITÓRIO e passava a agir
 * dentro da conta da vítima.
 *
 * A guarda de FORMATO ("dono/repositorio") não cobre isto: "vitima/repo" é um
 * endereço perfeitamente bem formado. O que faltava era cruzar o que o cliente
 * declara com o que ele de fato alcança no GitHub — informação que o próprio
 * wizard já busca para montar a lista da tela.
 */

interface ProjetoGravado {
  id: string
  wingId: string
  userId: string | null
}

interface Cenario {
  app: ReturnType<typeof Fastify>
  projetos: ProjetoGravado[]
  chaves: Array<{ projectId: string }>
  missoes: Array<{ projectId: string }>
  getRawGithubToken: ReturnType<typeof vi.fn>
}

/** Uma página de resposta do GitHub para a listagem de repositórios do usuário. */
function paginaDeRepos(nomes: string[]): Response {
  return new Response(
    JSON.stringify(
      nomes.map((fullName, indice) => ({
        id: indice + 1,
        name: fullName.split('/')[1],
        full_name: fullName,
        description: null,
        private: true,
        html_url: `https://github.com/${fullName}`,
      }))
    ),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

async function montarCenario(
  opcoes: { githubInstallationId?: number | null } = {}
): Promise<Cenario> {
  const projetos: ProjetoGravado[] = []
  const chaves: Array<{ projectId: string }> = []
  const missoes: Array<{ projectId: string }> = []
  let proximoId = 1

  const getRawGithubToken = vi.fn().mockResolvedValue('gho_token_do_atacante')

  const app = Fastify()
  app.decorate('engineConnections', {
    list: async () => [{ runtime: 'claude', status: 'connected' }],
    getRawGithubToken,
  } as unknown as EngineConnectionService)
  app.decorate('prisma', {
    user: {
      findUnique: vi.fn(async () => ({
        id: 'user_mallory',
        email: 'mallory@example.test',
        githubInstallationId: opcoes.githubInstallationId ?? null,
        plan: { id: 'pro', maxProjects: 5 },
      })),
    },
    plan: { findUnique: vi.fn().mockResolvedValue({ id: 'pro', maxProjects: 5 }) },
    project: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const registro = {
          id: `proj_${proximoId++}`,
          wingId: data['wingId'] as string,
          userId: (data['userId'] as string | undefined) ?? null,
        }
        projetos.push(registro)
        return { ...registro, name: data['name'], runtimeConfig: data['runtimeConfig'] }
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    apiKey: {
      create: vi.fn(async ({ data }: { data: { projectId: string } }) => {
        chaves.push({ projectId: data.projectId })
        return {}
      }),
    },
    mission: {
      create: vi.fn(async ({ data }: { data: { projectId: string } }) => {
        missoes.push({ projectId: data.projectId })
        return {}
      }),
    },
    projectSchedule: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({}),
    },
    clientEnvironment: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
  app.addHook('preHandler', async (request: FastifyRequest) => {
    request.user = { id: 'user_mallory', wingId: 'mallory', email: 'mallory@example.test' }
  })
  await setupRoutes(app)
  await app.ready()

  return { app, projetos, chaves, missoes, getRawGithubToken }
}

async function submeter(
  cenario: Cenario,
  repos: string[]
): Promise<{ statusCode: number; corpo: { error?: string; code?: string } }> {
  const res = await cenario.app.inject({
    method: 'POST',
    url: '/api/v1/setup/submit',
    payload: { repos, engines: ['claude-code'], plan: 'pro' },
  })
  return { statusCode: res.statusCode, corpo: res.json() as { error?: string; code?: string } }
}

describe('POST /api/v1/setup/submit — o repositório declarado tem de ser do cliente', () => {
  const fetchOriginal = global.fetch

  afterEach(() => {
    global.fetch = fetchOriginal
    vi.restoreAllMocks()
  })

  it('ATAQUE: cliente declara repositório de OUTRO cliente e o projeto NÃO nasce', async () => {
    const cenario = await montarCenario()
    // A lista real do atacante no GitHub não contém o repositório da vítima.
    global.fetch = vi.fn(async () =>
      paginaDeRepos(['mallory/rascunhos', 'mallory/site'])
    ) as unknown as typeof fetch

    const { statusCode, corpo } = await submeter(cenario, ['vitima/repo-privado'])

    expect(statusCode).toBe(403)
    expect(corpo.code).toBe('REPO_SEM_ACESSO')
    // Nada foi gravado: sem projeto, o produto nunca resolve a instalação da
    // vítima nem emite credencial sobre o repositório dela.
    expect(cenario.projetos).toHaveLength(0)
    expect(cenario.chaves).toHaveLength(0)
    expect(cenario.missoes).toHaveLength(0)
  })

  it('um repositório legítimo no meio do lote não salva o alheio: o submit inteiro é recusado', async () => {
    const cenario = await montarCenario()
    global.fetch = vi.fn(async () => paginaDeRepos(['mallory/site'])) as unknown as typeof fetch

    const { statusCode } = await submeter(cenario, ['mallory/site', 'vitima/repo-privado'])

    expect(statusCode).toBe(403)
    expect(cenario.projetos).toHaveLength(0)
  })

  it('COMPARAÇÃO EXATA: um repositório com o nome declarado como PREFIXO não autoriza', async () => {
    const cenario = await montarCenario()
    // "vitima/repo" é prefixo de "vitima/repo-publico-do-mallory": com
    // startsWith/includes o ataque passaria.
    global.fetch = vi.fn(async () =>
      paginaDeRepos(['vitima/repo-publico-do-mallory'])
    ) as unknown as typeof fetch

    const { statusCode } = await submeter(cenario, ['vitima/repo'])

    expect(statusCode).toBe(403)
    expect(cenario.projetos).toHaveLength(0)
  })

  it('o repositório do PRÓPRIO cliente passa, mesmo com caixa diferente da do GitHub', async () => {
    const cenario = await montarCenario()
    global.fetch = vi.fn(async () => paginaDeRepos(['Mallory/Meu-Repo'])) as unknown as typeof fetch

    const { statusCode } = await submeter(cenario, ['mallory/meu-repo'])

    expect(statusCode).toBe(200)
    expect(cenario.projetos).toHaveLength(1)
    // O endereço gravado é o que o cliente declarou — a checagem é de acesso,
    // não uma reescrita do que ele pediu.
    expect(cenario.projetos[0]!.wingId).toBe('mallory/meu-repo')
  })

  it('lista PAGINADA: o repositório que só aparece na 2ª página continua sendo aceito', async () => {
    const cenario = await montarCenario()
    // Página cheia (100) força a busca a pedir a próxima — é aí que uma
    // implementação de uma página só recusaria um cliente legítimo.
    const primeiraPagina = Array.from({ length: 100 }, (_, i) => `mallory/repo-${i}`)
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes('page=2')) return paginaDeRepos(['mallory/o-ultimo'])
      return paginaDeRepos(primeiraPagina)
    }) as unknown as typeof fetch

    const { statusCode } = await submeter(cenario, ['mallory/o-ultimo'])

    expect(statusCode).toBe(200)
    expect(cenario.projetos).toHaveLength(1)
  })

  it('falha de rede ao listar os repositórios NÃO vira "pode tudo": recusa com 503', async () => {
    const cenario = await montarCenario()
    global.fetch = vi.fn(async () => {
      throw new Error('socket hang up')
    }) as unknown as typeof fetch

    const { statusCode, corpo } = await submeter(cenario, ['mallory/meu-repo'])

    expect(statusCode).toBe(503)
    expect(corpo.code).toBe('REPOS_NAO_VERIFICAVEIS')
    expect(cenario.projetos).toHaveLength(0)
  })

  it('GitHub respondendo erro (5xx) na listagem também recusa, nunca aprova por omissão', async () => {
    const cenario = await montarCenario()
    global.fetch = vi.fn(
      async () => new Response('{"message":"Server Error"}', { status: 500 })
    ) as unknown as typeof fetch

    const { statusCode, corpo } = await submeter(cenario, ['mallory/meu-repo'])

    expect(statusCode).toBe(503)
    expect(corpo.code).toBe('REPOS_NAO_VERIFICAVEIS')
    expect(cenario.projetos).toHaveLength(0)
  })

  it('sem credencial do GitHub conectada não há como verificar: recusa em vez de criar', async () => {
    const cenario = await montarCenario()
    cenario.getRawGithubToken.mockResolvedValue(null)
    global.fetch = vi.fn(async () => paginaDeRepos(['mallory/meu-repo'])) as unknown as typeof fetch

    const { statusCode, corpo } = await submeter(cenario, ['mallory/meu-repo'])

    expect(statusCode).toBe(503)
    expect(corpo.code).toBe('REPOS_NAO_VERIFICAVEIS')
    expect(cenario.projetos).toHaveLength(0)
  })

  it('endereço fora do formato "dono/repositorio" é recusado na porta', async () => {
    const cenario = await montarCenario()
    global.fetch = vi.fn(async () => paginaDeRepos(['mallory/meu-repo'])) as unknown as typeof fetch

    const { statusCode, corpo } = await submeter(cenario, ['../../user/repos?'])

    expect(statusCode).toBe(400)
    expect(corpo.code).toBe('REPO_FORMATO_INVALIDO')
    expect(cenario.projetos).toHaveLength(0)
  })
})

describe('POST /api/v1/setup/submit — verificação pelo GitHub App instalado', () => {
  const fetchOriginal = global.fetch
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

  beforeEach(() => {
    resetAppTokenCache()
    process.env['GITHUB_APP_ID'] = 'app_123'
    process.env['GITHUB_APP_PRIVATE_KEY'] = privateKey
  })

  afterEach(() => {
    global.fetch = fetchOriginal
    resetAppTokenCache()
    delete process.env['GITHUB_APP_ID']
    delete process.env['GITHUB_APP_PRIVATE_KEY']
    vi.restoreAllMocks()
  })

  /** Responde ao mint do installation token e à listagem da instalação. */
  function fetchDaInstalacao(reposDaInstalacao: string[]): typeof fetch {
    return vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes('/app/installations/777/access_tokens')) {
        return new Response(
          JSON.stringify({
            token: 'ghs_instalacao',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 201 }
        )
      }
      if (href.includes('/installation/repositories')) {
        return new Response(
          JSON.stringify({
            total_count: reposDaInstalacao.length,
            repositories: reposDaInstalacao.map((fullName, indice) => ({
              id: indice + 1,
              name: fullName.split('/')[1],
              full_name: fullName,
              description: null,
              private: true,
              html_url: `https://github.com/${fullName}`,
            })),
          }),
          { status: 200 }
        )
      }
      throw new Error(`chamada inesperada ao GitHub: ${href}`)
    }) as unknown as typeof fetch
  }

  it('repositório fora da instalação autorizada pelo cliente é recusado', async () => {
    const cenario = await montarCenario({ githubInstallationId: 777 })
    global.fetch = fetchDaInstalacao(['mallory/autorizado'])

    const { statusCode, corpo } = await submeter(cenario, ['vitima/repo-privado'])

    expect(statusCode).toBe(403)
    expect(corpo.code).toBe('REPO_SEM_ACESSO')
    expect(cenario.projetos).toHaveLength(0)
  })

  it('repositório dentro da instalação autorizada passa', async () => {
    const cenario = await montarCenario({ githubInstallationId: 777 })
    global.fetch = fetchDaInstalacao(['mallory/autorizado'])

    const { statusCode } = await submeter(cenario, ['mallory/autorizado'])

    expect(statusCode).toBe(200)
    expect(cenario.projetos).toHaveLength(1)
  })
})
