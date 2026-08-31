import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { setupRoutes, TETO_DE_PROVAS_DA_TELA } from './setup.js'
import type { EngineConnectionService } from '../services/engine-connection.js'
import { resetAppTokenCache } from '../services/github-app-token.js'

/** Permissões do portador do token, como o GitHub as devolve. */
const PODE_ESCREVER = { admin: true, maintain: true, push: true, triage: true, pull: true }

/**
 * O que o GitHub responde sobre os repositórios do cliente.
 *
 * Duas perguntas diferentes, e a distinção é o que a rodada de conserto
 * introduziu:
 * - a LISTAGEM (`/user/repos`, `/installation/repositories`) só monta a tela;
 * - a PROVA (`/repos/{dono}/{repo}`, com o token do próprio cliente) é o que
 *   AUTORIZA — `permissions.push` decide, e 404 é o "não" do GitHub.
 *
 * Por isso todo cenário de submit precisa dizer o que o cliente ESCREVE: sem
 * resposta, o pedido é recusado por não ser verificável, que é o comportamento
 * correto.
 *
 * Devolve `null` para qualquer outra chamada, para as suítes que já roteiam
 * GraphQL/REST continuarem tratando o resto como antes.
 */
function respostaDaListaDeRepos(url: unknown, doCliente: string[]): Response | null {
  const href = String(url)
  if (href.includes('/user/repos') || href.includes('/installation/repositories')) {
    return new Response(JSON.stringify(doCliente.map((full_name) => ({ full_name }))), {
      status: 200,
    })
  }
  const prova = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/?#]+)$/.exec(href)
  if (!prova) return null
  const nome = prova[1] ?? ''
  const alcanca = doCliente.some((r) => r.toLowerCase() === nome.toLowerCase())
  if (!alcanca) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
  return new Response(JSON.stringify({ full_name: nome, permissions: PODE_ESCREVER }), {
    status: 200,
  })
}

/** `global.fetch` que só sabe responder sobre os repositórios do cliente. */
function fetchSoDaListaDeRepos(doCliente: string[]): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const lista = respostaDaListaDeRepos(url, doCliente)
    if (lista) return lista
    throw new Error(`chamada inesperada ao GitHub neste cenário: ${String(url)}`)
  }) as unknown as typeof fetch
}

describe('GET /api/v1/github/repos', () => {
  let app: ReturnType<typeof Fastify>
  const originalFetch = global.fetch
  let getRawGithubToken: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    getRawGithubToken = vi.fn().mockResolvedValue('gh_encrypted_roundtrip_token')

    app = Fastify()
    app.decorate('engineConnections', {
      getRawGithubToken,
    } as unknown as EngineConnectionService)
    // Sem instalação do GitHub App escolhida — vai direto pro caminho OAuth
    // clássico, que é o que este describe cobre.
    app.decorate('prisma', {
      user: {
        findUnique: vi.fn().mockResolvedValue({ githubInstallationId: null, planId: 'free' }),
      },
      // Teto de repos vem de Plan.maxProjects (free = 1) — a rota /clone lê isto
      // do banco, nunca do corpo da requisição (anti-burla).
      plan: { findUnique: vi.fn().mockResolvedValue({ maxProjects: 1 }) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    // Simula o hook global de auth já tendo populado request.user (cookie ou
    // Bearer) — o token do GitHub em si NÃO vem mais daqui (spec §17.4).
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'user_1', wingId: 'octocat' }
    })
    await setupRoutes(app)
    await app.ready()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('rejects POST /api/v1/setup/clone when repo count exceeds plan limit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/clone',
      payload: { repos: ['owner/repo1', 'owner/repo2'] },
    })

    expect(res.statusCode).toBe(400)
    const json = JSON.parse(res.payload)
    expect(json.code).toBe('REPOS_EXCEED_PLAN_LIMIT')
  })

  it('IGNORA o plano do corpo — usa o plano REAL do banco (anti-burla)', async () => {
    // O banco diz que o usuário é 'free' (teto 1). Mesmo mandando plan:'team' no
    // corpo (a burla clássica), o servidor lê User.planId + Plan.maxProjects e
    // continua bloqueando 2 repositórios. Antes, `plan ?? body` deixava o
    // cliente escolher o próprio limite.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/clone',
      payload: { repos: ['owner/repo1', 'owner/repo2'], plan: 'team' },
    })

    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload).code).toBe('REPOS_EXCEED_PLAN_LIMIT')
  })

  it('fetches repos using the token decrypted from the user vault, not the session', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.startsWith('https://api.github.com/user/repos')) {
        return new Response(
          JSON.stringify([
            {
              id: 1,
              name: 'repo',
              full_name: 'octocat/repo',
              description: null,
              private: false,
              html_url: 'https://github.com/octocat/repo',
              permissions: PODE_ESCREVER,
            },
          ]),
          { status: 200 }
        )
      }
      throw new Error('chamada inesperada ao GitHub neste cenário: ' + href)
    }) as unknown as typeof fetch

    const res = await app.inject({ method: 'GET', url: '/api/v1/github/repos' })

    expect(res.statusCode).toBe(200)
    expect(getRawGithubToken).toHaveBeenCalledWith('user_1')
    const chamadas = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    // A listagem vai com o token do CLIENTE, nunca com a chave do App.
    for (const chamada of chamadas) {
      const headers = chamada?.[1]?.headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer gh_encrypted_roundtrip_token')
    }
  })

  /**
   * Montar a tela custava 1 + N: a listagem, e depois uma prova por candidato.
   * Um cliente com cem repositórios gastava até 101 chamadas da cota DELE — a
   * mesma cota do clone, do diagnóstico e da coleta de contexto — só para ver
   * a lista.
   *
   * A resposta de `GET /user/repos` já traz, em cada item, o bloco
   * `permissions` do PORTADOR DO TOKEN. Para MONTAR a oferta isso basta, e
   * pelo mesmo critério do passo final (`push`), então a tela continua não
   * oferecendo o que o submit vai recusar.
   */
  it('a tela sai de UMA chamada: a listagem do próprio cliente já traz permissions', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.startsWith('https://api.github.com/user/repos')) {
        return new Response(
          JSON.stringify([
            {
              id: 1,
              name: 'a',
              full_name: 'octocat/a',
              description: null,
              private: false,
              html_url: 'https://github.com/octocat/a',
              permissions: PODE_ESCREVER,
            },
            {
              id: 2,
              name: 'b',
              full_name: 'octocat/b',
              description: null,
              private: false,
              html_url: 'https://github.com/octocat/b',
              permissions: PODE_ESCREVER,
            },
            {
              id: 3,
              name: 'c',
              full_name: 'octocat/c',
              description: null,
              private: false,
              html_url: 'https://github.com/octocat/c',
              permissions: PODE_ESCREVER,
            },
          ]),
          { status: 200 }
        )
      }
      throw new Error('a tela não deve provar repositório um a um: ' + href)
    }) as unknown as typeof fetch

    const res = await app.inject({ method: 'GET', url: '/api/v1/github/repos' })

    expect(res.statusCode).toBe(200)
    expect((res.json() as Array<{ fullName: string }>).map((r) => r.fullName)).toEqual([
      'octocat/a',
      'octocat/b',
      'octocat/c',
    ])
    expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })

  // A tela e o passo final têm de concordar. A listagem vinha crua de
  // `GET /user/repos`, que por padrão inclui repositório de colaborador
  // só-leitura e de membro da organização; o passo final passou a exigir
  // escrita. Sem este filtro, a tela ofereceria um repositório para o clique
  // seguinte recusar com "você não tem acesso" — e ainda daria ao cliente a
  // impressão de que aquilo é dele.
  it('não oferece na tela o repositório em que o cliente só pode LER', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.startsWith('https://api.github.com/user/repos')) {
        return new Response(
          JSON.stringify([
            {
              id: 1,
              name: 'repo',
              full_name: 'octocat/repo',
              description: null,
              private: false,
              html_url: 'https://github.com/octocat/repo',
              permissions: PODE_ESCREVER,
            },
            {
              id: 2,
              name: 'cofre',
              full_name: 'vitima/cofre',
              description: null,
              private: true,
              html_url: 'https://github.com/vitima/cofre',
              // Só leitura: aparece na listagem (o GitHub lista o que a pessoa
              // ENXERGA), mas não pode ser oferecido.
              permissions: {
                admin: false,
                maintain: false,
                push: false,
                triage: false,
                pull: true,
              },
            },
            {
              id: 3,
              name: 'antigo',
              full_name: 'vitima/antigo',
              description: null,
              private: true,
              html_url: 'https://github.com/vitima/antigo',
              // Listagem sem o bloco `permissions` (resposta truncada, versão
              // antiga da API): sem prova de escrita não se oferece nada.
            },
          ]),
          { status: 200 }
        )
      }
      throw new Error('a tela não deve provar repositório um a um: ' + href)
    }) as unknown as typeof fetch

    const res = await app.inject({ method: 'GET', url: '/api/v1/github/repos' })

    expect(res.statusCode).toBe(200)
    const lista = res.json() as Array<{ fullName: string }>
    expect(lista.map((r) => r.fullName)).toEqual(['octocat/repo'])
  })

  it('returns 401 when the user has no connected github token', async () => {
    getRawGithubToken.mockResolvedValue(null)
    const res = await app.inject({ method: 'GET', url: '/api/v1/github/repos' })
    expect(res.statusCode).toBe(401)
  })

  // Achado real do QA (19/07): o token do usuário existe (foi conectado um
  // dia) mas o GitHub o rejeita — expirado ou revogado no lado deles. A API
  // REST responde 401 com {"message": "Bad credentials", ...} (um objeto, não
  // array), o que ANTES caía sem classificar no branch genérico
  // `!Array.isArray(repos)` -> 500 cru. Contrato de erro do wizard exige um
  // code estável, igual ao que POST /setup/clone já devolve.
  it('token GitHub expirado/revogado (GitHub responde 401 Bad credentials) -> 401 com code GITHUB_TOKEN_EXPIRED, não 500 cru', async () => {
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          message: 'Bad credentials',
          documentation_url: 'https://docs.github.com/rest',
        }),
        { status: 401 }
      )
    }) as unknown as typeof fetch

    const res = await app.inject({ method: 'GET', url: '/api/v1/github/repos' })

    expect(res.statusCode).toBe(401)
    const body = res.json() as { error?: string; code?: string }
    expect(body.code).toBe('GITHUB_TOKEN_EXPIRED')
    expect(res.statusCode).not.toBe(500)
  })

  it('GitHub rate-limitando (403 com mensagem de rate limit) -> 429 com code RATE_LIMITED', async () => {
    global.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ message: 'API rate limit exceeded for x.x.x.x.' }), {
        status: 403,
      })
    }) as unknown as typeof fetch

    const res = await app.inject({ method: 'GET', url: '/api/v1/github/repos' })

    expect(res.statusCode).toBe(429)
    const body = res.json() as { code?: string }
    expect(body.code).toBe('RATE_LIMITED')
  })
})

describe('GET /api/v1/github/repos — sem o plugin de motores registrado', () => {
  it('retorna um 500 limpo em vez de vazar o TypeError interno pro cliente', async () => {
    const app = Fastify()
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'user_1', wingId: 'octocat' }
    })
    await setupRoutes(app)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/github/repos' })
    expect(res.statusCode).toBe(500)
    const body = res.json() as { message?: string; error?: string }
    const leaked = `${body.message ?? ''} ${body.error ?? ''}`
    expect(leaked).not.toContain('getRawGithubToken')
    expect(leaked).not.toContain('Cannot read properties')
  })
})

/**
 * F1 Onda 2 — GET /api/v1/github/repos via installation do GitHub App: quem
 * já instalou (routes/github-app-install.ts) e escolheu repositórios na
 * própria tela do GitHub deixa de depender do escopo amplo do OAuth App
 * clássico (`repo`, todos os repositórios da conta). Os dois caminhos
 * coexistem — compat é o próprio requisito: quem nunca instalou o App
 * continua funcionando exatamente como antes.
 */
describe('GET /api/v1/github/repos — via installation do GitHub App (F1 Onda 2)', () => {
  let app: ReturnType<typeof Fastify>
  const originalFetch = global.fetch
  let getRawGithubToken: ReturnType<typeof vi.fn>
  let userFindUnique: ReturnType<typeof vi.fn>
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

  beforeEach(async () => {
    resetAppTokenCache()
    process.env['GITHUB_APP_ID'] = 'app_123'
    process.env['GITHUB_APP_PRIVATE_KEY'] = privateKey

    getRawGithubToken = vi.fn().mockResolvedValue('gh_oauth_fallback_token')
    userFindUnique = vi.fn().mockResolvedValue({ githubInstallationId: 555 })

    app = Fastify()
    app.decorate('engineConnections', {
      getRawGithubToken,
    } as unknown as EngineConnectionService)
    app.decorate('prisma', {
      user: { findUnique: userFindUnique },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'user_1', wingId: 'octocat' }
    })
    await setupRoutes(app)
    await app.ready()
  })

  afterEach(() => {
    global.fetch = originalFetch
    resetAppTokenCache()
    delete process.env['GITHUB_APP_ID']
    delete process.env['GITHUB_APP_PRIVATE_KEY']
  })

  it('usuário com githubInstallationId: os CANDIDATOS vêm da instalação, sem passar pelo /user/repos', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes('/app/installations/555/access_tokens')) {
        return new Response(
          JSON.stringify({
            token: 'ghs_install',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 201 }
        )
      }
      if (href.startsWith('https://api.github.com/installation/repositories')) {
        return new Response(
          JSON.stringify({
            total_count: 1,
            repositories: [
              {
                id: 9,
                name: 'privado',
                full_name: 'octocat/privado',
                description: 'só o que ele autorizou',
                private: true,
                html_url: 'https://github.com/octocat/privado',
              },
            ],
          }),
          { status: 200 }
        )
      }
      if (href === 'https://api.github.com/repos/octocat/privado') {
        return new Response(
          JSON.stringify({ full_name: 'octocat/privado', permissions: PODE_ESCREVER }),
          { status: 200 }
        )
      }
      throw new Error('URL inesperada no teste: ' + href)
    }) as unknown as typeof fetch

    const res = await app.inject({ method: 'GET', url: '/api/v1/github/repos' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      {
        id: 9,
        name: 'privado',
        fullName: 'octocat/privado',
        description: 'só o que ele autorizou',
        private: true,
        url: 'https://github.com/octocat/privado',
      },
    ])
    // O token do cliente É lido — e tem de ser: a instalação diz o que PODE
    // aparecer, mas quem autoriza é a prova por repositório, e ela pergunta
    // com a credencial dele. A listagem ampla do OAuth é que não acontece.
    expect(getRawGithubToken).toHaveBeenCalledWith('user_1')
    const chamadas = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
    expect(chamadas.some((u) => u.startsWith('https://api.github.com/user/repos'))).toBe(false)
  })

  it('installation token indisponível (App não configurado/acessível): cai pro OAuth clássico, sem quebrar o wizard', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes('/access_tokens')) {
        return new Response(JSON.stringify({}), { status: 401 })
      }
      if (href.startsWith('https://api.github.com/user/repos')) {
        // Listagem do PRÓPRIO cliente: o `permissions` daqui é dele, e é o que
        // monta a oferta neste caminho — sem prova extra por repositório.
        return new Response(
          JSON.stringify([
            {
              id: 1,
              name: 'repo',
              full_name: 'octocat/repo',
              description: null,
              private: false,
              html_url: 'https://github.com/octocat/repo',
              permissions: PODE_ESCREVER,
            },
          ]),
          { status: 200 }
        )
      }
      throw new Error('URL inesperada no teste: ' + href)
    }) as unknown as typeof fetch

    const res = await app.inject({ method: 'GET', url: '/api/v1/github/repos' })

    expect(res.statusCode).toBe(200)
    expect(getRawGithubToken).toHaveBeenCalledWith('user_1')
    expect(res.json()).toEqual([
      {
        id: 1,
        name: 'repo',
        fullName: 'octocat/repo',
        description: null,
        private: false,
        url: 'https://github.com/octocat/repo',
      },
    ])
  })

  /**
   * A tela não pode oferecer o que o passo final vai recusar — nem, pior,
   * sugerir ao cliente que o repositório alheio é dele.
   *
   * `GET /installation/repositories` é do APP e devolve TODA a instalação: numa
   * organização, isso inclui repositório que aquele cliente não alcança. A
   * listagem serve para MONTAR a tela; quem AUTORIZA é a prova por repositório
   * com o token do próprio cliente.
   */
  it('a tela só oferece o que o CLIENTE escreve, mesmo que a instalação cubra mais', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes('/app/installations/555/access_tokens')) {
        return new Response(
          JSON.stringify({
            token: 'ghs_install',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 201 }
        )
      }
      if (href.startsWith('https://api.github.com/installation/repositories')) {
        return new Response(
          JSON.stringify({
            total_count: 2,
            repositories: [
              {
                id: 9,
                name: 'api',
                full_name: 'acme/api',
                description: null,
                private: true,
                html_url: 'https://github.com/acme/api',
              },
              {
                id: 10,
                name: 'segredos',
                full_name: 'acme/segredos',
                description: null,
                private: true,
                html_url: 'https://github.com/acme/segredos',
              },
            ],
          }),
          { status: 200 }
        )
      }
      if (href === 'https://api.github.com/repos/acme/api') {
        return new Response(
          JSON.stringify({
            full_name: 'acme/api',
            permissions: { admin: false, maintain: false, push: true, triage: true, pull: true },
          }),
          { status: 200 }
        )
      }
      if (href === 'https://api.github.com/repos/acme/segredos') {
        // O cliente não alcança este: o GitHub esconde com 404.
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
      }
      throw new Error('URL inesperada no teste: ' + href)
    }) as unknown as typeof fetch

    const res = await app.inject({ method: 'GET', url: '/api/v1/github/repos' })

    expect(res.statusCode).toBe(200)
    const lista = res.json() as Array<{ fullName: string }>
    expect(lista.map((r) => r.fullName)).toEqual(['acme/api'])
  })

  /**
   * Quem tem instalação gravada não passa mais pela listagem OAuth — e era
   * ali que o 401 do GitHub virava "reconecte o GitHub". Com a listagem
   * saindo da chave do App (que continua válida), a credencial morta do
   * cliente só aparecia DENTRO da prova, virava "não verificável", e a tela
   * mandava tentar de novo em instantes — para sempre, porque tentar de novo
   * nunca ressuscita um token revogado.
   */
  it('credencial do cliente revogada: a tela manda RECONECTAR, não "tente de novo"', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes('/app/installations/555/access_tokens')) {
        return new Response(
          JSON.stringify({
            token: 'ghs_install',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 201 }
        )
      }
      if (href.startsWith('https://api.github.com/installation/repositories')) {
        return new Response(
          JSON.stringify({
            total_count: 1,
            repositories: [
              {
                id: 9,
                name: 'api',
                full_name: 'acme/api',
                description: null,
                private: true,
                html_url: 'https://github.com/acme/api',
              },
            ],
          }),
          { status: 200 }
        )
      }
      // A prova vai com o token do CLIENTE — e é ele que o GitHub rejeita.
      return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })
    }) as unknown as typeof fetch

    const res = await app.inject({ method: 'GET', url: '/api/v1/github/repos' })

    expect(res.statusCode).toBe(401)
    expect((res.json() as { code?: string }).code).toBe('GITHUB_TOKEN_EXPIRED')
  })

  /**
   * O caminho da instalação é o ÚNICO em que a prova por repositório na tela é
   * inevitável: a resposta de `/installation/repositories` também traz
   * `permissions`, mas é a permissão do APP naquele repositório, não a do
   * cliente — foi exatamente ler esse bloco como se fosse dele que deixava a
   * colaboradora de um repositório enxergar o vizinho.
   *
   * Como cada prova custa uma chamada da cota do cliente, o número delas tem
   * teto. Acima dele a tela oferece menos do que a instalação cobre, e isso
   * fica no log — melhor uma oferta menor do que uma tela que gasta a cota do
   * cliente inteira toda vez que ele a abre.
   */
  it('instalação enorme: a tela prova no máximo o teto de candidatos, não um por repositório', async () => {
    const cobertos = Array.from({ length: TETO_DE_PROVAS_DA_TELA + 7 }, (_, i) => ({
      id: i + 1,
      name: `repo${i}`,
      full_name: `acme/repo${i}`,
      description: null,
      private: true,
      html_url: `https://github.com/acme/repo${i}`,
    }))
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.includes('/app/installations/555/access_tokens')) {
        return new Response(
          JSON.stringify({
            token: 'ghs_install',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 201 }
        )
      }
      if (href.startsWith('https://api.github.com/installation/repositories')) {
        return new Response(
          JSON.stringify({ total_count: cobertos.length, repositories: cobertos }),
          {
            status: 200,
          }
        )
      }
      const prova = /^https:\/\/api\.github\.com\/repos\/(acme\/repo\d+)$/.exec(href)
      if (prova) {
        return new Response(JSON.stringify({ full_name: prova[1], permissions: PODE_ESCREVER }), {
          status: 200,
        })
      }
      throw new Error('URL inesperada no teste: ' + href)
    }) as unknown as typeof fetch

    const res = await app.inject({ method: 'GET', url: '/api/v1/github/repos' })

    expect(res.statusCode).toBe(200)
    const provas = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .filter((u) => /^https:\/\/api\.github\.com\/repos\//.test(u))
    expect(provas).toHaveLength(TETO_DE_PROVAS_DA_TELA)
    expect(res.json() as unknown[]).toHaveLength(TETO_DE_PROVAS_DA_TELA)
  })

  it('usuário sem githubInstallationId: nem tenta mintar token do App — vai direto pro OAuth', async () => {
    userFindUnique.mockResolvedValue({ githubInstallationId: null })
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url)
      if (href.startsWith('https://api.github.com/user/repos')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      throw new Error('não deveria tentar mintar token do App sem installationId: ' + href)
    }) as unknown as typeof fetch

    const res = await app.inject({ method: 'GET', url: '/api/v1/github/repos' })

    expect(res.statusCode).toBe(200)
    expect(getRawGithubToken).toHaveBeenCalledWith('user_1')
  })
})

describe('POST /api/v1/setup/submit — runtime wiring', () => {
  let app: ReturnType<typeof Fastify>
  const originalFetch = global.fetch
  let projectCreate: ReturnType<typeof vi.fn>
  let engineConnectionFindMany: ReturnType<typeof vi.fn> &
    ((userId: string) => Promise<Array<{ runtime: string; status: string }>>)

  afterEach(() => {
    global.fetch = originalFetch
  })

  beforeEach(async () => {
    global.fetch = fetchSoDaListaDeRepos(['octocat/repo'])
    projectCreate = vi.fn().mockImplementation(async ({ data }) => ({
      id: 'proj_1',
      wingId: data.wingId,
      name: data.name,
      isActive: true,
      runtimeConfig: data.runtimeConfig,
    }))
    engineConnectionFindMany = vi.fn().mockResolvedValue([
      { runtime: 'claude', status: 'connected' },
      { runtime: 'codex', status: 'error' },
    ]) as typeof engineConnectionFindMany

    app = Fastify()
    app.decorate('engineConnections', {
      list: async (userId: string) => {
        const rows = (await engineConnectionFindMany(userId)) as Array<{
          runtime: string
          status: string
        }>
        return rows.map((r) => ({
          ...r,
          modelsRefreshedAt: null,
          lastValidatedAt: null,
          lastError: null,
        }))
      },
      getRawGithubToken: async () => 'gh_test_token',
    } as unknown as EngineConnectionService)
    app.decorate('prisma', {
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'owner_1', email: 'octocat@example.test', plan: null }),
      },
      plan: { findUnique: vi.fn().mockResolvedValue({ id: 'pro', maxProjects: 2 }) },
      project: {
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn().mockResolvedValue(null),
        create: projectCreate,
      },
      apiKey: { create: vi.fn().mockResolvedValue({}) },
      mission: { create: vi.fn().mockResolvedValue({}) },
      projectSchedule: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({}),
      },
      clientEnvironment: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([]),
        // current() (chamado após fix() para disparar o bootstrap de
        // recursos, W1.2.2) usa findFirst — sem ambiente nenhum aqui, devolve
        // null e o disparo do bootstrap é pulado (não é o que este teste
        // exercita).
        findFirst: vi.fn().mockResolvedValue(null),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'owner_1', wingId: 'octocat', email: 'octocat@example.test' }
    })
    await setupRoutes(app)
    await app.ready()
  })

  it('maps claude-code to claude and writes runtimeConfig.agents for every role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/submit',
      payload: { repos: ['octocat/repo'], engines: ['claude-code'], plan: 'pro' },
    })

    expect(res.statusCode).toBe(200)
    const createCall = projectCreate.mock.calls[0]![0] as {
      data: { runtimeConfig: { agents: Record<string, { runtime: string }> } }
    }
    const agents = createCall.data.runtimeConfig.agents
    for (const role of ['po', 'ra', 'sm', 'qa']) {
      expect(agents[role]?.runtime).toBe('claude')
    }
  })

  it('rejects submit when none of the selected engines is actually connected', async () => {
    engineConnectionFindMany.mockResolvedValue([{ runtime: 'codex', status: 'error' }])
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/submit',
      payload: { repos: ['octocat/repo'], engines: ['claude-code'], plan: 'pro' },
    })
    expect(res.statusCode).toBe(400)
    expect(projectCreate).not.toHaveBeenCalled()
  })

  it('checks connected engines under the resolved owner.id, not the raw session claim, when they differ', async () => {
    // Sessão com um userId diferente do id real do dono (ex.: cookie emitido
    // antes de uma correção de id) — EngineConnection sempre foi gravado sob
    // o id resolvido por e-mail (owner.id), então é esse que tem que ser usado
    // pra achar o motor conectado, senão o gate bloqueia um dono já conectado.
    app.prisma.user.findUnique = vi
      .fn()
      .mockResolvedValue({ id: 'owner_real_cuid', email: 'octocat@example.test', plan: null })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/submit',
      payload: { repos: ['octocat/repo'], engines: ['claude-code'], plan: 'pro' },
    })

    expect(engineConnectionFindMany).toHaveBeenCalledWith('owner_real_cuid')
    expect(res.statusCode).toBe(200)
  })
})

describe('POST /api/v1/setup/submit — coleta de contexto: board Projects V2 não duplica em re-submit', () => {
  let app: ReturnType<typeof Fastify>
  const originalFetch = global.fetch
  let byWingId: Map<
    string,
    {
      id: string
      wingId: string
      name: string
      runtimeConfig: unknown
      autonomia?: string | undefined
      autonomiaEscolhidaEm?: Date | undefined
    }
  >
  let cortexWriteDrawer: ReturnType<typeof vi.fn>

  // Roteia o `fetch` GraphQL pelo conteúdo da query — mesma técnica usada nos
  // testes de repo-context-collector/repo-context-cortex, mas aqui contra o
  // `global.fetch` de verdade: setup.ts não injeta um transporte de teste,
  // então é o único jeito de exercitar o fluxo INTEIRO (rota → collector →
  // GraphQL) sem bater na rede real.
  function stubGithubGraphQL(handlers: { boardNumberCreated: number }): typeof fetch {
    return vi.fn(async (url: string, init: { body: string }) => {
      // A prova de que o repositório é do cliente vem antes de qualquer
      // GraphQL — sem ela o submit nem chega na coleta de contexto.
      const lista = respostaDaListaDeRepos(url, ['octocat/repo'])
      if (lista) return lista
      const body = JSON.parse(init.body) as { query: string }
      if (body.query.includes('RepoOwner')) {
        return new Response(
          JSON.stringify({
            data: { repository: { owner: { id: 'U_owner', __typename: 'User' } } },
          }),
          { status: 200 }
        )
      }
      if (body.query.includes('ListarQuadrosDoRepositorio')) {
        // A pergunta que a coleta passou a fazer ANTES de criar: "já existe
        // quadro ligado a este repositório?". Aqui não existe nenhum, que é
        // exatamente o caso em que criar é legítimo.
        return new Response(
          JSON.stringify({ data: { repository: { projectsV2: { nodes: [] } } } }),
          { status: 200 }
        )
      }
      if (body.query.includes('GetProjectId')) {
        // Só é chamada quando um boardNumber já é conhecido (reuse) — devolve
        // o MESMO board criado na 1ª rodada.
        return new Response(
          JSON.stringify({ data: { user: { projectV2: { id: 'PVT_reused' } } } }),
          { status: 200 }
        )
      }
      if (body.query.includes('CreateProjectV2')) {
        return new Response(
          JSON.stringify({
            data: {
              createProjectV2: {
                projectV2: { id: 'PVT_created', number: handlers.boardNumberCreated },
              },
            },
          }),
          { status: 200 }
        )
      }
      if (body.query.includes('RepoContext')) {
        return new Response(
          JSON.stringify({
            data: { repository: { pullRequests: { nodes: [] }, issues: { nodes: [] } } },
          }),
          { status: 200 }
        )
      }
      throw new Error(`stub sem handler para a query:\n${body.query}`)
    }) as unknown as typeof fetch
  }

  beforeEach(async () => {
    byWingId = new Map()
    let nextId = 1
    cortexWriteDrawer = vi.fn().mockResolvedValue(undefined)

    app = Fastify()
    app.decorate('cortex', { writeDrawer: cortexWriteDrawer } as never)
    app.decorate('engineConnections', {
      list: async () => [
        {
          runtime: 'claude',
          status: 'connected',
          modelsRefreshedAt: null,
          lastValidatedAt: null,
          lastError: null,
        },
      ],
      getRawGithubToken: async () => 'gh_test_token',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    app.decorate('prisma', {
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'owner_1', email: 'octocat@example.test', plan: null }),
      },
      plan: { findUnique: vi.fn().mockResolvedValue({ id: 'pro', maxProjects: 2 }) },
      project: {
        count: vi.fn().mockResolvedValue(0),
        // Stateful: reflete o estado real entre os dois submits do teste — é
        // isso que prova a idempotência (2º submit ACHA o project do 1º).
        findFirst: vi.fn(async ({ where }: { where: { wingId: string } }) => {
          return byWingId.get(where.wingId) ?? null
        }),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const rec = {
            id: `proj_${nextId++}`,
            wingId: data['wingId'] as string,
            name: data['name'] as string,
            runtimeConfig: data['runtimeConfig'],
            // O nível escolhido no assistente e a data da escolha: é o que
            // separa "o cliente decidiu" de "está no padrão porque ninguém
            // decidiu". Sem guardar aqui, o teste não consegue conferir.
            autonomia: data['autonomia'] as string | undefined,
            autonomiaEscolhidaEm: data['autonomiaEscolhidaEm'] as Date | undefined,
          }
          byWingId.set(rec.wingId, rec)
          return rec
        }),
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const rec = [...byWingId.values()].find((p) => p.id === where.id)
            if (rec) Object.assign(rec, data)
            return rec
          }
        ),
        // Nenhum cliente passou por /setup/credencial-do-cliente neste
        // teste — lerCredencialDoProjeto (chamada pela coleta de contexto)
        // precisa deste método existir para resolver "sem credencial" (null),
        // não para quebrar com um TypeError.
        findUnique: vi.fn().mockResolvedValue(null),
      },
      apiKey: { create: vi.fn().mockResolvedValue({}) },
      mission: { create: vi.fn().mockResolvedValue({}) },
      projectSchedule: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({}),
      },
      clientEnvironment: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([]),
        // current() (chamado após fix() para disparar o bootstrap de
        // recursos, W1.2.2) usa findFirst — sem ambiente nenhum aqui, devolve
        // null e o disparo do bootstrap é pulado (não é o que este teste
        // exercita).
        findFirst: vi.fn().mockResolvedValue(null),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'owner_1', wingId: 'octocat', email: 'octocat@example.test' }
    })
    await setupRoutes(app)
    await app.ready()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('2 submits do mesmo repo: só o 1º cria o board GitHub; o 2º reusa via runtimeConfig persistido', async () => {
    global.fetch = stubGithubGraphQL({ boardNumberCreated: 42 })

    // `autonomia: 'cuidar'` porque este teste é sobre CRIAR o quadro, e criar
    // quadro é escrita no repositório do cliente. Decisão do dono (29/08): o
    // nível é escolhido no assistente, e sem escolha o produto não escreve.
    const payload = {
      repos: ['octocat/repo'],
      engines: ['claude-code'],
      plan: 'pro',
      autonomia: 'cuidar',
    }

    const first = await app.inject({ method: 'POST', url: '/api/v1/setup/submit', payload })
    expect(first.statusCode).toBe(200)

    // Só as chamadas GraphQL têm corpo — a listagem de repositórios do cliente
    // (a prova de que o repo é dele) é um GET sem corpo.
    const soGraphQL = (chamadas: unknown[][]): string[] =>
      chamadas
        .filter((c) => (c[1] as { body?: string } | undefined)?.body)
        .map((c) => (JSON.parse((c[1] as { body: string }).body) as { query: string }).query)

    const fetchCalls1 = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    const queriesRound1 = soGraphQL(fetchCalls1)
    expect(queriesRound1.some((q) => q.includes('CreateProjectV2'))).toBe(true)
    expect(queriesRound1.some((q) => q.includes('GetProjectId'))).toBe(false)

    // O board criado (número 42) foi persistido no Project.
    const project = byWingId.get('octocat/repo')
    expect((project?.runtimeConfig as { githubBoardNumber?: number })?.githubBoardNumber).toBe(42)

    // 2ª submissão do MESMO repo (reabrir/refinalizar o wizard) — a rota deve
    // ler o boardNumber persistido e REUSAR, não criar um board novo.
    ;(global.fetch as ReturnType<typeof vi.fn>).mockClear()
    const second = await app.inject({ method: 'POST', url: '/api/v1/setup/submit', payload })
    expect(second.statusCode).toBe(200)

    const fetchCalls2 = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    const queriesRound2 = soGraphQL(fetchCalls2)
    expect(queriesRound2.some((q) => q.includes('GetProjectId'))).toBe(true)
    expect(queriesRound2.some((q) => q.includes('CreateProjectV2'))).toBe(false)

    // Só 1 Project foi criado no total (2ª submissão reusou o registro).
    expect(byWingId.size).toBe(1)
  })

  // O OUTRO LADO da mesma decisão (dono, 29/08): quem escolhe "só olhar" — ou
  // não escolhe nada — NÃO tem quadro criado no repositório dele. O assistente
  // completa mesmo assim; não é erro, é a escolha valendo.
  it('sem escolher o nível, o assistente completa e NÃO cria quadro no repositório', async () => {
    global.fetch = stubGithubGraphQL({ boardNumberCreated: 42 })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/submit',
      // Sem `autonomia`: é o cliente que não escolheu. O padrão é o mais
      // restrito, e o produto não escreve no repositório de quem não autorizou.
      payload: { repos: ['octocat/repo'], engines: ['claude-code'], plan: 'pro' },
    })

    // O assistente termina normalmente — a recusa não vira erro para o cliente.
    expect(res.statusCode).toBe(200)

    const queries = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => (c[1] as { body?: string } | undefined)?.body)
      .map((c) => (JSON.parse((c[1] as { body: string }).body) as { query: string }).query)

    // Nenhum quadro foi criado.
    expect(queries.some((q) => q.includes('CreateProjectV2'))).toBe(false)
    // E nada de número de quadro gravado no projeto.
    const project = byWingId.get('octocat/repo')
    expect(
      (project?.runtimeConfig as { githubBoardNumber?: number })?.githubBoardNumber
    ).toBeUndefined()
    // O projeto nasceu no nível mais restrito, e sem data de escolha — porque
    // ninguém escolheu.
    expect((project as { autonomia?: string })?.autonomia).toBe('so_olhar')
    expect((project as { autonomiaEscolhidaEm?: Date })?.autonomiaEscolhidaEm).toBeUndefined()
  })

  it('escolher "só olhar" explicitamente carimba a data — é diferente de não escolher', async () => {
    global.fetch = stubGithubGraphQL({ boardNumberCreated: 42 })

    await app.inject({
      method: 'POST',
      url: '/api/v1/setup/submit',
      payload: {
        repos: ['octocat/repo'],
        engines: ['claude-code'],
        plan: 'pro',
        autonomia: 'so_olhar',
      },
    })

    const project = byWingId.get('octocat/repo')
    expect((project as { autonomia?: string })?.autonomia).toBe('so_olhar')
    // A data é o que separa "ele decidiu isto" de "está no padrão". Sem essa
    // diferença o painel diria "você escolheu só olhar" a quem nunca escolheu.
    expect((project as { autonomiaEscolhidaEm?: Date })?.autonomiaEscolhidaEm).toBeInstanceOf(Date)
  })

  it('nível inventado NÃO vira permissão — cai no mais restrito', async () => {
    global.fetch = stubGithubGraphQL({ boardNumberCreated: 42 })

    await app.inject({
      method: 'POST',
      url: '/api/v1/setup/submit',
      payload: {
        repos: ['octocat/repo'],
        engines: ['claude-code'],
        plan: 'pro',
        autonomia: 'administrador-total',
      },
    })

    const project = byWingId.get('octocat/repo')
    expect((project as { autonomia?: string })?.autonomia).toBe('so_olhar')
    // E não carimba data: um valor que ninguém reconhece não é uma escolha.
    expect((project as { autonomiaEscolhidaEm?: Date })?.autonomiaEscolhidaEm).toBeUndefined()
    const queries = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => (c[1] as { body?: string } | undefined)?.body)
      .map((c) => (JSON.parse((c[1] as { body: string }).body) as { query: string }).query)
    expect(queries.some((q) => q.includes('CreateProjectV2'))).toBe(false)
  })
})

describe('POST /api/v1/setup/submit — plano autoritativo (paid-intent, ainda não pago)', () => {
  let app: ReturnType<typeof Fastify>
  const originalFetch = global.fetch
  let projectCreate: ReturnType<typeof vi.fn>
  let planFindUnique: ReturnType<typeof vi.fn>

  afterEach(() => {
    global.fetch = originalFetch
  })

  beforeEach(async () => {
    global.fetch = fetchSoDaListaDeRepos(['octocat/repo1', 'octocat/repo2', 'octocat/repo3'])
    projectCreate = vi.fn().mockImplementation(async ({ data }) => ({
      id: 'proj_1',
      wingId: data.wingId,
      name: data.name,
      isActive: true,
      runtimeConfig: data.runtimeConfig,
    }))
    // Plano REAL do dono no banco (schema default): 'free', maxProjects 1 —
    // ainda não subiu porque o webhook do Stripe só roda após o pagamento.
    const freePlan = { id: 'free', maxProjects: 1, features: {} }
    planFindUnique = vi
      .fn()
      .mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === 'team' ? { id: 'team', maxProjects: 10, features: {} } : null
      )

    app = Fastify()
    app.decorate('engineConnections', {
      list: async () => [{ runtime: 'claude', status: 'connected' }],
      getRawGithubToken: async () => 'gh_test_token',
    } as unknown as EngineConnectionService)
    app.decorate('prisma', {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'owner_1',
          email: 'octocat@example.test',
          plan: freePlan,
        }),
      },
      plan: { findUnique: planFindUnique },
      project: {
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn().mockResolvedValue(null),
        create: projectCreate,
      },
      apiKey: { create: vi.fn().mockResolvedValue({}) },
      mission: { create: vi.fn().mockResolvedValue({}) },
      projectSchedule: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({}),
      },
      clientEnvironment: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([]),
        // current() (chamado após fix() para disparar o bootstrap de
        // recursos, W1.2.2) usa findFirst — sem ambiente nenhum aqui, devolve
        // null e o disparo do bootstrap é pulado (não é o que este teste
        // exercita).
        findFirst: vi.fn().mockResolvedValue(null),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'owner_1', wingId: 'octocat', email: 'octocat@example.test' }
    })
    await setupRoutes(app)
    await app.ready()
  })

  it('permite múltiplos repos quando o cliente veio de ?plan=team, mesmo o dono ainda estando no free no banco', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/submit',
      payload: {
        repos: ['octocat/repo1', 'octocat/repo2', 'octocat/repo3'],
        engines: ['claude-code'],
        plan: 'team',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(projectCreate).toHaveBeenCalledTimes(3)
  })

  it('rejeita um plano inventado pelo cliente que não existe no banco (cai no teto free)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/submit',
      payload: {
        repos: ['octocat/repo1', 'octocat/repo2'],
        engines: ['claude-code'],
        plan: 'plano-fake-inventado',
      },
    })

    expect(res.statusCode).toBe(400)
    expect(projectCreate).not.toHaveBeenCalled()
  })

  it('cliente JÁ pagante (plano real pro) reabrindo o wizard sem ?plan= mantém o teto real, não o do free', async () => {
    // Front usa 'free' como default quando não há ?plan= na URL — um cliente
    // que já paga não pode ser rebaixado ao teto do free só por isso.
    app.prisma.user.findUnique = vi.fn().mockResolvedValue({
      id: 'owner_1',
      email: 'octocat@example.test',
      plan: { id: 'pro', maxProjects: 5 },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/submit',
      payload: {
        repos: ['octocat/repo1', 'octocat/repo2'],
        engines: ['claude-code'],
        plan: 'free',
      },
    })

    expect(res.statusCode).toBe(200)
    expect(projectCreate).toHaveBeenCalledTimes(2)
  })
})

describe('POST /api/v1/setup/submit — isolamento entre clientes (o projeto é do DONO)', () => {
  let app: ReturnType<typeof Fastify>
  let currentUser: { id: string; wingId: string; email?: string }
  let projects: Array<{
    id: string
    wingId: string
    name: string
    userId: string | null
    runtimeConfig: unknown
  }>
  let apiKeys: Array<{ projectId: string }>
  let owners: Record<string, { id: string; email: string }>
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  beforeEach(async () => {
    // Ana e Bob são os dois colaboradores REAIS de "acme/api" — o repositório
    // aparece na lista dos dois, e é exatamente por isso que o cenário do
    // vazamento continua válido depois da guarda de acesso.
    global.fetch = fetchSoDaListaDeRepos(['acme/api'])
    projects = []
    apiKeys = []
    let nextId = 1
    owners = {
      'ana@example.test': { id: 'user_ana', email: 'ana@example.test' },
      'bob@example.test': { id: 'user_bob', email: 'bob@example.test' },
    }
    currentUser = { id: 'user_ana', wingId: 'acme', email: 'ana@example.test' }

    app = Fastify()
    app.decorate('engineConnections', {
      list: async () => [{ runtime: 'claude', status: 'connected' }],
      getRawGithubToken: async () => 'gh_test_token',
    } as unknown as EngineConnectionService)
    app.decorate('prisma', {
      user: {
        findUnique: vi.fn(async ({ where }: { where: { email: string } }) => {
          const owner = owners[where.email]
          return owner ? { ...owner, plan: { id: 'pro', maxProjects: 5 } } : null
        }),
      },
      plan: { findUnique: vi.fn().mockResolvedValue({ id: 'pro', maxProjects: 5 }) },
      project: {
        count: vi.fn(
          async ({ where }: { where: { userId?: string } }) =>
            projects.filter((p) => p.userId === where.userId).length
        ),
        // Honra TODOS os campos do `where`, como o Postgres faz. É exatamente
        // isso que torna o vazamento visível: com a busca só por `wingId`, o
        // segundo cliente ACHA o projeto do primeiro.
        findFirst: vi.fn(
          async ({ where }: { where: { wingId?: string; userId?: string } }) =>
            projects.find(
              (p) =>
                (where.wingId === undefined || p.wingId === where.wingId) &&
                (where.userId === undefined || p.userId === where.userId)
            ) ?? null
        ),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const rec = {
            id: `proj_${nextId++}`,
            wingId: data['wingId'] as string,
            name: data['name'] as string,
            userId: (data['userId'] as string | undefined) ?? null,
            runtimeConfig: data['runtimeConfig'],
          }
          projects.push(rec)
          return rec
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      apiKey: {
        create: vi.fn(async ({ data }: { data: { projectId: string } }) => {
          apiKeys.push({ projectId: data.projectId })
          return {}
        }),
      },
      mission: { create: vi.fn().mockResolvedValue({}) },
      projectSchedule: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({}),
      },
      clientEnvironment: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn().mockResolvedValue([]),
        // current() (chamado após fix() para disparar o bootstrap de
        // recursos, W1.2.2) usa findFirst — sem ambiente nenhum aqui, devolve
        // null e o disparo do bootstrap é pulado (não é o que este teste
        // exercita).
        findFirst: vi.fn().mockResolvedValue(null),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = currentUser
    })
    await setupRoutes(app)
    await app.ready()
  })

  const submit = async (): Promise<{
    projects: Array<{ id: string; wingId: string; apiKey: string }>
  }> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/submit',
      payload: { repos: ['acme/api'], engines: ['claude-code'], plan: 'pro' },
    })
    expect(res.statusCode).toBe(200)
    return res.json() as { projects: Array<{ id: string; wingId: string; apiKey: string }> }
  }

  it('VAZAMENTO: o cliente B fazendo setup do MESMO repo do cliente A não recebe o projeto de A', async () => {
    // Dois colaboradores do mesmo repositório ("acme/api") passam pelo wizard.
    // Com o Project.wingId único GLOBAL e a busca só por wingId, o segundo
    // ACHAVA o Project do primeiro e ganhava uma ApiKey VÁLIDA sobre o projeto
    // alheio — controle total do repo de outro cliente. O projeto é do DONO:
    // mesmo repo, donos diferentes, projetos diferentes.
    currentUser = { id: 'user_ana', wingId: 'acme', email: 'ana@example.test' }
    const ana = await submit()

    currentUser = { id: 'user_bob', wingId: 'acme', email: 'bob@example.test' }
    const bob = await submit()

    const anaProject = ana.projects[0]!
    const bobProject = bob.projects[0]!

    // B NÃO recebeu o projeto de A.
    expect(bobProject.id).not.toBe(anaProject.id)
    // Nasceram dois projetos, um por dono, ambos para o mesmo repo.
    expect(projects).toHaveLength(2)
    expect(projects.map((p) => p.userId).sort()).toEqual(['user_ana', 'user_bob'])
    expect(projects.every((p) => p.wingId === 'acme/api')).toBe(true)
    // E a ApiKey de B está sobre o projeto de B — nunca sobre o de A.
    expect(apiKeys.map((k) => k.projectId)).toEqual([anaProject.id, bobProject.id])
  })

  it('idempotência preservada: o MESMO dono resubmetendo o mesmo repo reusa o projeto dele', async () => {
    const first = await submit()
    const second = await submit()

    expect(second.projects[0]!.id).toBe(first.projects[0]!.id)
    expect(projects).toHaveLength(1)
  })

  it('todo projeto nasce COM dono (nunca no limbo global de onde o próximo cliente o acha)', async () => {
    await submit()
    expect(projects[0]!.userId).toBe('user_ana')
  })

  /**
   * As duas colunas de identidade do GitHub são ÚNICAS no banco. Se o cadastro
   * as escrevesse, quem chegasse primeiro tomaria o identificador do
   * repositório e o dono de verdade não conseguiria mais se cadastrar — a
   * unicidade já estaria ocupada e o erro chegaria como falha crua.
   *
   * A defesa é não escrever: o cadastro guarda só o endereço declarado. Quem
   * preenche a identidade é o fluxo autenticado do GitHub, e sob as condições
   * de routes/github-webhook.ts.
   */
  it('o projeto nasce SEM a identidade do GitHub: ela não faz parte do cadastro', async () => {
    await submit()

    const chamadas = (app.prisma.project.create as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(chamadas).toHaveLength(1)
    const dados = (chamadas[0]![0] as { data: Record<string, unknown> }).data
    expect(dados).not.toHaveProperty('githubRepoId')
    expect(dados).not.toHaveProperty('githubInstallationId')
  })

  it('401 quando o dono da sessão não é resolvível (sem dono não há a quem pertencer o projeto)', async () => {
    // Sessão sem e-mail (JWT legado) ou cujo usuário não existe mais: sem dono
    // resolvido, o projeto nasceria órfão num namespace global — a porta exata
    // do vazamento. Recusa em vez de criar.
    currentUser = { id: 'user_fantasma', wingId: 'acme' }

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/submit',
      payload: { repos: ['acme/api'], engines: ['claude-code'], plan: 'pro' },
    })

    expect(res.statusCode).toBe(401)
    expect(projects).toHaveLength(0)
    expect(apiKeys).toHaveLength(0)
  })
})

describe('POST /api/v1/setup/credencial-do-cliente', () => {
  let app: ReturnType<typeof Fastify>
  const originalFetch = global.fetch
  const originalKey = process.env['GITORCH_CREDENTIAL_KEY']
  let projectFindFirst: ReturnType<typeof vi.fn>
  let projectUpdate: ReturnType<typeof vi.fn>

  // Simula a resposta de GET /user do GitHub — mesmo formato que
  // verificarCredencial (services/project-credential.ts) consome.
  const stubGithubUser = (escopos: string): void => {
    global.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ login: 'cliente' }), {
        status: 200,
        headers: { 'x-oauth-scopes': escopos },
      })
    }) as unknown as typeof fetch
  }

  beforeEach(async () => {
    process.env['GITORCH_CREDENTIAL_KEY'] = randomBytes(32).toString('hex')

    projectFindFirst = vi.fn().mockResolvedValue({ id: 'proj_1' })
    projectUpdate = vi.fn().mockResolvedValue({})

    app = Fastify()
    app.decorate('prisma', {
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: 'owner_1', email: 'octocat@example.test' }),
      },
      project: { findFirst: projectFindFirst, update: projectUpdate },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'owner_1', wingId: 'octocat', email: 'octocat@example.test' }
    })
    await setupRoutes(app)
    await app.ready()
  })

  afterEach(() => {
    global.fetch = originalFetch
    if (originalKey === undefined) delete process.env['GITORCH_CREDENTIAL_KEY']
    else process.env['GITORCH_CREDENTIAL_KEY'] = originalKey
  })

  it('recusa credencial sem os escopos, dizendo exatamente o que falta', async () => {
    stubGithubUser('repo')
    const resp = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/credencial-do-cliente',
      payload: { projectId: 'proj_1', token: 'tok-sem-escopo' },
    })
    expect(resp.statusCode).toBe(400)
    expect(resp.json().faltando).toContain('project')
    expect(projectUpdate).not.toHaveBeenCalled()
  })

  it('aceita credencial completa e não devolve o segredo de volta', async () => {
    stubGithubUser('repo, project')
    const resp = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/credencial-do-cliente',
      payload: { projectId: 'proj_1', token: 'tok-completo' },
    })
    expect(resp.statusCode).toBe(200)
    expect(JSON.stringify(resp.json())).not.toContain('tok-completo')
    expect(resp.json()).toEqual({ login: 'cliente', faltando: [] })

    // A credencial foi guardada CIFRADA — nunca em texto puro.
    expect(projectUpdate).toHaveBeenCalledTimes(1)
    const gravado = projectUpdate.mock.calls[0]![0].data.encryptedClientToken as string
    expect(gravado).not.toContain('tok-completo')
  })

  it('prova de dono: recusa quando o projeto não pertence ao dono resolvido da sessão', async () => {
    // findFirst filtrado por { id, userId } não acha nada — o mesmo padrão
    // anti-vazamento que o submit já usa (isolamento entre clientes).
    projectFindFirst.mockResolvedValue(null)
    stubGithubUser('repo, project')

    const resp = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/credencial-do-cliente',
      payload: { projectId: 'proj_de_outro_dono', token: 'tok-completo' },
    })

    expect(resp.statusCode).toBe(404)
    expect(projectUpdate).not.toHaveBeenCalled()
    expect(projectFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'proj_de_outro_dono', userId: 'owner_1' }),
      })
    )
  })

  it('GitHub indisponível (5xx): não culpa a credencial, diz que não deu para verificar agora', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch

    const resp = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/credencial-do-cliente',
      payload: { projectId: 'proj_1', token: 'tok-qualquer' },
    })

    expect(resp.statusCode).toBe(503)
    const body = resp.json() as { erro?: string }
    expect(body.erro).not.toMatch(/inválid/i)
    expect(projectUpdate).not.toHaveBeenCalled()
  })

  it('401 sem sessão', async () => {
    const semSessao = Fastify()
    await setupRoutes(semSessao)
    await semSessao.ready()
    const resp = await semSessao.inject({
      method: 'POST',
      url: '/api/v1/setup/credencial-do-cliente',
      payload: { projectId: 'proj_1', token: 'tok' },
    })
    expect(resp.statusCode).toBe(401)
  })

  it('400 quando faltam campos obrigatórios no corpo', async () => {
    const resp = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/credencial-do-cliente',
      payload: { projectId: 'proj_1' },
    })
    expect(resp.statusCode).toBe(400)
  })
})

describe('POST /api/v1/setup/submit — coleta de contexto usa a instalação do App no repositório', () => {
  let app: ReturnType<typeof Fastify>
  const originalFetch = global.fetch
  const originalKey = process.env['GITORCH_CREDENTIAL_KEY']
  const originalAppId = process.env['GITHUB_APP_ID']
  const originalAppKey = process.env['GITHUB_APP_PRIVATE_KEY']
  let cortexWriteDrawer: ReturnType<typeof vi.fn>

  function stubGithubGraphQLAndRest(opts: { installationId?: number } = {}): typeof fetch {
    const installationId = opts.installationId ?? 555
    return vi.fn(async (url: string, init?: { body?: string }) => {
      const lista = respostaDaListaDeRepos(url, ['octocat/repo'])
      if (lista) return lista
      if (init?.body) {
        const body = JSON.parse(init.body) as { query: string }
        if (body.query.includes('RepoOwner')) {
          return new Response(
            JSON.stringify({
              data: { repository: { owner: { id: 'U_owner', __typename: 'User' } } },
            }),
            { status: 200 }
          )
        }
        if (body.query.includes('ListarQuadrosDoRepositorio')) {
          // Repositório sem quadro ligado: é o único caso em que criar é a
          // resposta certa.
          return new Response(
            JSON.stringify({ data: { repository: { projectsV2: { nodes: [] } } } }),
            { status: 200 }
          )
        }
        if (body.query.includes('CreateProjectV2')) {
          return new Response(
            JSON.stringify({
              data: { createProjectV2: { projectV2: { id: 'PVT_created', number: 42 } } },
            }),
            { status: 200 }
          )
        }
        if (body.query.includes('RepoContext')) {
          return new Response(
            JSON.stringify({
              data: { repository: { pullRequests: { nodes: [] }, issues: { nodes: [] } } },
            }),
            { status: 200 }
          )
        }
        throw new Error(`stub sem handler para a query GraphQL:
${body.query}`)
      }
      const caminho = String(url).replace('https://api.github.com', '')
      if (caminho === '/repos/octocat/repo/installation') {
        return new Response(JSON.stringify({ id: installationId }), { status: 200 })
      }
      if (caminho === `/app/installations/${installationId}/access_tokens`) {
        return new Response(
          JSON.stringify({
            token: 'ghs_installation_token',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200 }
        )
      }
      const mapa: Record<string, { status: number; corpo?: unknown }> = {
        '/repos/octocat/repo/contents/.github/dependabot.yml': { status: 404 },
        '/repos/octocat/repo/dependabot/alerts?state=open&per_page=100': { status: 200, corpo: [] },
      }
      const r = mapa[caminho] ?? { status: 404 }
      return new Response(r.corpo === undefined ? null : JSON.stringify(r.corpo), {
        status: r.status,
      })
    }) as unknown as typeof fetch
  }

  beforeEach(async () => {
    process.env['GITORCH_CREDENTIAL_KEY'] = randomBytes(32).toString('hex')
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    process.env['GITHUB_APP_ID'] = '999'
    process.env['GITHUB_APP_PRIVATE_KEY'] = privateKey
    resetAppTokenCache()
    cortexWriteDrawer = vi.fn().mockResolvedValue(undefined)

    app = Fastify()
    app.decorate('cortex', { writeDrawer: cortexWriteDrawer } as never)
    app.decorate('engineConnections', {
      list: async () => [
        {
          runtime: 'claude',
          status: 'connected',
          modelsRefreshedAt: null,
          lastValidatedAt: null,
          lastError: null,
        },
      ],
      getRawGithubToken: async () => 'gh_app_token',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    app.decorate('prisma', {
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'owner_1', email: 'octocat@example.test', plan: null }),
      },
      plan: { findUnique: vi.fn().mockResolvedValue({ id: 'pro', maxProjects: 2 }) },
      project: {
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'proj_1',
          wingId: data['wingId'],
          name: data['name'],
          runtimeConfig: data['runtimeConfig'],
        })),
        update: vi.fn().mockResolvedValue({}),
      },
      apiKey: { create: vi.fn().mockResolvedValue({}) },
      mission: { create: vi.fn().mockResolvedValue({}) },
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
      request.user = { id: 'owner_1', wingId: 'octocat', email: 'octocat@example.test' }
    })
    await setupRoutes(app)
    await app.ready()
  })

  afterEach(() => {
    global.fetch = originalFetch
    if (originalKey === undefined) delete process.env['GITORCH_CREDENTIAL_KEY']
    else process.env['GITORCH_CREDENTIAL_KEY'] = originalKey
    if (originalAppId === undefined) delete process.env['GITHUB_APP_ID']
    else process.env['GITHUB_APP_ID'] = originalAppId
    if (originalAppKey === undefined) delete process.env['GITHUB_APP_PRIVATE_KEY']
    else process.env['GITHUB_APP_PRIVATE_KEY'] = originalAppKey
  })

  it('com o App instalado no repositório: a dívida de segurança é coletada e vira gaveta', async () => {
    global.fetch = stubGithubGraphQLAndRest()

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/submit',
      payload: {
        repos: ['octocat/repo'],
        engines: ['claude-code'],
        plan: 'pro',
        // A coleta da dívida atravessa o mesmo caminho que cria o quadro, e
        // criar quadro é escrita no repositório do cliente.
        autonomia: 'cuidar',
      },
    })

    expect(res.statusCode).toBe(200)
    const drawerIds = cortexWriteDrawer.mock.calls.map((c) => (c[0] as { id: string }).id)
    expect(drawerIds).toContain('github:octocat/repo:divida-de-seguranca')
  })

  it('sem o App instalado no repositório (404 ao resolver a instalação): submit continua funcionando, sem gaveta de dívida', async () => {
    const base = stubGithubGraphQLAndRest()
    global.fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith('/repos/octocat/repo/installation')) {
        return new Response(null, { status: 404 })
      }
      return (base as unknown as (u: string, i?: unknown) => Promise<Response>)(url, init)
    }) as unknown as typeof fetch

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/submit',
      payload: {
        repos: ['octocat/repo'],
        engines: ['claude-code'],
        plan: 'pro',
        // A coleta atravessa o mesmo caminho que cria o quadro.
        autonomia: 'cuidar',
      },
    })

    expect(res.statusCode).toBe(200)
    const drawerIds = cortexWriteDrawer.mock.calls.map((c) => (c[0] as { id: string }).id)
    expect(drawerIds).not.toContain('github:octocat/repo:divida-de-seguranca')
  })
})
