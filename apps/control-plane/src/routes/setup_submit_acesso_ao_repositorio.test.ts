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
 * endereço perfeitamente bem formado. O que faltava era perguntar ao GitHub, de
 * forma DIRETA, se aquele cliente pode escrever ali.
 *
 * A pergunta é `GET /repos/{dono}/{repositorio}` com o token do PRÓPRIO
 * cliente, e o que autoriza é `permissions.push === true` na resposta. As
 * versões anteriores perguntavam por tabela — a lista de quem ele enxerga, a
 * lista do App — e cada conserto abria a variante seguinte.
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

/**
 * O bloco `permissions` que o GitHub devolve em `GET /repos/{dono}/{repo}` — as
 * permissões DO PORTADOR DO TOKEN naquele repositório. Saída real da API.
 */
const COMO_DONO = { admin: true, maintain: true, push: true, triage: true, pull: true }
const SO_LEITURA = { admin: false, maintain: false, push: false, triage: false, pull: true }
const SO_ESCRITA = { admin: false, maintain: false, push: true, triage: true, pull: true }

/**
 * `global.fetch` que responde à prova por repositório como o GitHub responde:
 * o que está no mapa devolve `permissions`; o resto devolve 404 — que é como a
 * API esconde tanto o repositório inexistente quanto o privado inacessível.
 *
 * As chaves são comparadas sem diferença de caixa porque o GitHub também
 * resolve `Dono/Repo` e `dono/repo` como o mesmo endereço.
 */
function fetchDaProva(doCliente: Record<string, Record<string, boolean>>): typeof fetch {
  const porEndereco = new Map(
    Object.entries(doCliente).map(([nome, permissoes]) => [nome.toLowerCase(), permissoes])
  )
  return vi.fn(async (url: string | URL | Request) => {
    const href = String(url)
    const nome = href.replace('https://api.github.com/repos/', '')
    const permissoes = porEndereco.get(nome.toLowerCase())
    if (!permissoes) {
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
    }
    return new Response(JSON.stringify({ full_name: nome, permissions: permissoes }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
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
    // Mallory escreve nos dele; o da vítima o GitHub esconde com 404.
    global.fetch = fetchDaProva({
      'mallory/rascunhos': COMO_DONO,
      'mallory/site': COMO_DONO,
    })

    const { statusCode, corpo } = await submeter(cenario, ['vitima/repo-privado'])

    expect(statusCode).toBe(403)
    expect(corpo.code).toBe('REPO_SEM_ACESSO')
    // Nada foi gravado: sem projeto, o produto nunca resolve a instalação da
    // vítima nem emite credencial sobre o repositório dela.
    expect(cenario.projetos).toHaveLength(0)
    expect(cenario.chaves).toHaveLength(0)
    expect(cenario.missoes).toHaveLength(0)
  })

  it('ATAQUE: colaborador SÓ-LEITURA no repositório da vítima é recusado', async () => {
    // Mallory ENXERGA "vitima/api" — foi adicionado como colaborador de
    // leitura —, então o GitHub responde 200 para ele naquele endereço. É o
    // bloco `permissions` que separa ver de escrever: sem essa régua, o projeto
    // nasceria e a esteira passaria a agir ali com o token da INSTALAÇÃO, que
    // escreve — ler viraria escrever.
    const cenario = await montarCenario()
    global.fetch = fetchDaProva({ 'vitima/api': SO_LEITURA })

    const { statusCode, corpo } = await submeter(cenario, ['vitima/api'])

    expect(statusCode).toBe(403)
    expect(corpo.code).toBe('REPO_SEM_ACESSO')
    expect(cenario.projetos).toHaveLength(0)
    expect(cenario.chaves).toHaveLength(0)
    expect(cenario.missoes).toHaveLength(0)
  })

  it('colaborador COM ESCRITA é aceito: a régua é poder escrever, não ser dono', async () => {
    const cenario = await montarCenario()
    global.fetch = fetchDaProva({ 'acme/api': SO_ESCRITA })

    const { statusCode } = await submeter(cenario, ['acme/api'])

    expect(statusCode).toBe(200)
    expect(cenario.projetos).toHaveLength(1)
  })

  it('um repositório legítimo no meio do lote não salva o alheio: o submit inteiro é recusado', async () => {
    const cenario = await montarCenario()
    global.fetch = fetchDaProva({ 'mallory/site': COMO_DONO })

    const { statusCode } = await submeter(cenario, ['mallory/site', 'vitima/repo-privado'])

    expect(statusCode).toBe(403)
    expect(cenario.projetos).toHaveLength(0)
  })

  it('PERGUNTA EXATA: um repositório com o nome declarado como PREFIXO não autoriza', async () => {
    const cenario = await montarCenario()
    // "vitima/repo" é prefixo de "vitima/repo-publico-do-mallory": com
    // startsWith/includes numa listagem o ataque passaria. Aqui a pergunta é
    // pelo endereço EXATO, e o GitHub responde 404.
    global.fetch = fetchDaProva({ 'vitima/repo-publico-do-mallory': COMO_DONO })

    const { statusCode } = await submeter(cenario, ['vitima/repo'])

    expect(statusCode).toBe(403)
    expect(cenario.projetos).toHaveLength(0)
  })

  it('o repositório do PRÓPRIO cliente passa, mesmo com caixa diferente da do GitHub', async () => {
    const cenario = await montarCenario()
    global.fetch = fetchDaProva({ 'Mallory/Meu-Repo': COMO_DONO })

    const { statusCode } = await submeter(cenario, ['mallory/meu-repo'])

    expect(statusCode).toBe(200)
    expect(cenario.projetos).toHaveLength(1)
    // O endereço gravado é o que o cliente declarou — a checagem é de acesso,
    // não uma reescrita do que ele pediu.
    expect(cenario.projetos[0]!.wingId).toBe('mallory/meu-repo')
  })

  it('UMA chamada exata por repositório: nada de listagem nem de paginação', async () => {
    // A versão anterior varria `GET /user/repos` página a página, e um cliente
    // com muitos repositórios dependia de a varredura chegar até o dele. A
    // pergunta direta não tem esse risco: é um endereço, uma chamada.
    const cenario = await montarCenario()
    const fetchImpl = fetchDaProva({ 'mallory/o-ultimo': COMO_DONO })
    global.fetch = fetchImpl

    const { statusCode } = await submeter(cenario, ['mallory/o-ultimo'])

    expect(statusCode).toBe(200)
    expect(cenario.projetos).toHaveLength(1)
    const chamadas = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(chamadas.map((c) => String(c[0]))).toEqual([
      'https://api.github.com/repos/mallory/o-ultimo',
    ])
  })

  it('falha de rede na prova NÃO vira "pode tudo": recusa com 503', async () => {
    const cenario = await montarCenario()
    global.fetch = vi.fn(async () => {
      throw new Error('socket hang up')
    }) as unknown as typeof fetch

    const { statusCode, corpo } = await submeter(cenario, ['mallory/meu-repo'])

    expect(statusCode).toBe(503)
    expect(corpo.code).toBe('REPOS_NAO_VERIFICAVEIS')
    expect(cenario.projetos).toHaveLength(0)
  })

  it('GitHub respondendo erro (5xx) na prova também recusa, nunca aprova por omissão', async () => {
    const cenario = await montarCenario()
    global.fetch = vi.fn(
      async () => new Response('{"message":"Server Error"}', { status: 500 })
    ) as unknown as typeof fetch

    const { statusCode, corpo } = await submeter(cenario, ['mallory/meu-repo'])

    expect(statusCode).toBe(503)
    expect(corpo.code).toBe('REPOS_NAO_VERIFICAVEIS')
    expect(cenario.projetos).toHaveLength(0)
  })

  /**
   * Credencial revogada é um fato com solução — reconectar — e não podia
   * chegar ao cliente com o rótulo de indisponibilidade, que só sabe pedir
   * "tente de novo". A recusa continua exatamente a mesma; o que muda é o que
   * a tela pode dizer a respeito.
   */
  it('credencial revogada: recusa dizendo RECONECTE, não "tente de novo em instantes"', async () => {
    const cenario = await montarCenario()
    global.fetch = vi.fn(
      async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })
    ) as unknown as typeof fetch

    const { statusCode, corpo } = await submeter(cenario, ['mallory/meu-repo'])

    expect(statusCode).toBe(401)
    expect(corpo.code).toBe('GITHUB_TOKEN_EXPIRED')
    expect(cenario.projetos).toHaveLength(0)
  })

  it('sem credencial do GitHub conectada não há como verificar: recusa em vez de criar', async () => {
    const cenario = await montarCenario()
    cenario.getRawGithubToken.mockResolvedValue(null)
    global.fetch = fetchDaProva({ 'mallory/meu-repo': COMO_DONO })

    const { statusCode, corpo } = await submeter(cenario, ['mallory/meu-repo'])

    expect(statusCode).toBe(503)
    expect(corpo.code).toBe('REPOS_NAO_VERIFICAVEIS')
    expect(cenario.projetos).toHaveLength(0)
  })

  it('endereço fora do formato "dono/repositorio" é recusado na porta', async () => {
    const cenario = await montarCenario()
    global.fetch = fetchDaProva({ 'mallory/meu-repo': COMO_DONO })

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

  /**
   * O ATAQUE que esta suíte fecha, e que a rodada anterior deixou aberto: a
   * instalação do GitHub App numa ORGANIZAÇÃO cobre repositórios que aquele
   * cliente não alcança. `GET /installation/repositories` é do APP (token
   * assinado com a chave privada), então responde a lista INTEIRA da
   * instalação — e a colaboradora legítima de `acme/api` conseguia declarar
   * `acme/segredos` só porque os dois estão sob a mesma instalação.
   *
   * A prova que vale agora é `GET /repos/{dono}/{repo}` com o token do PRÓPRIO
   * cliente: ali o `permissions` é dele, naquele endereço.
   */
  function fetchDaOrganizacao(args: {
    daInstalacao: string[]
    /** O que o CLIENTE realmente alcança, por endereço. */
    doCliente: Record<string, Record<string, boolean>>
  }): typeof fetch {
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
            total_count: args.daInstalacao.length,
            repositories: args.daInstalacao.map((full_name, i) => ({ id: i + 1, full_name })),
          }),
          { status: 200 }
        )
      }
      const nome = href.replace('https://api.github.com/repos/', '')
      const permissoes = args.doCliente[nome]
      if (!permissoes)
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
      return new Response(JSON.stringify({ full_name: nome, permissions: permissoes }), {
        status: 200,
      })
    }) as unknown as typeof fetch
  }

  it('ATAQUE: repositório da MESMA instalação da organização que o cliente não escreve é recusado', async () => {
    const cenario = await montarCenario({ githubInstallationId: 777 })
    global.fetch = fetchDaOrganizacao({
      // A instalação da organização cobre os dois repositórios...
      daInstalacao: ['acme/api', 'acme/segredos'],
      // ...mas o cliente só escreve num deles.
      doCliente: { 'acme/api': COMO_DONO },
    })

    const { statusCode, corpo } = await submeter(cenario, ['acme/segredos'])

    expect(statusCode).toBe(403)
    expect(corpo.code).toBe('REPO_SEM_ACESSO')
    expect(cenario.projetos).toHaveLength(0)
  })

  it('ATAQUE: colaborador SÓ-LEITURA de um repositório da instalação também é recusado', async () => {
    const cenario = await montarCenario({ githubInstallationId: 777 })
    global.fetch = fetchDaOrganizacao({
      daInstalacao: ['acme/api', 'acme/segredos'],
      doCliente: { 'acme/api': COMO_DONO, 'acme/segredos': SO_LEITURA },
    })

    const { statusCode, corpo } = await submeter(cenario, ['acme/segredos'])

    expect(statusCode).toBe(403)
    expect(corpo.code).toBe('REPO_SEM_ACESSO')
    expect(cenario.projetos).toHaveLength(0)
  })

  it('a prova NUNCA usa a credencial da instalação: o token que pergunta é o do cliente', async () => {
    const cenario = await montarCenario({ githubInstallationId: 777 })
    const fetchImpl = fetchDaOrganizacao({
      daInstalacao: ['acme/api'],
      doCliente: { 'acme/api': COMO_DONO },
    })
    global.fetch = fetchImpl

    await submeter(cenario, ['acme/api'])

    const chamadas = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls
    const prova = chamadas.find((c) => String(c[0]) === 'https://api.github.com/repos/acme/api')
    expect(prova).toBeDefined()
    const headers = prova?.[1]?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer gho_token_do_atacante')
    expect(headers['Authorization']).not.toContain('ghs_instalacao')
  })

  it('repositório que o cliente não alcança é recusado, mesmo com o App instalado', async () => {
    const cenario = await montarCenario({ githubInstallationId: 777 })
    global.fetch = fetchDaOrganizacao({
      daInstalacao: ['mallory/autorizado'],
      doCliente: { 'mallory/autorizado': COMO_DONO },
    })

    const { statusCode, corpo } = await submeter(cenario, ['vitima/repo-privado'])

    expect(statusCode).toBe(403)
    expect(corpo.code).toBe('REPO_SEM_ACESSO')
    expect(cenario.projetos).toHaveLength(0)
  })

  it('repositório em que o cliente escreve passa, com ou sem App instalado', async () => {
    const cenario = await montarCenario({ githubInstallationId: 777 })
    global.fetch = fetchDaOrganizacao({
      daInstalacao: ['mallory/autorizado'],
      doCliente: { 'mallory/autorizado': COMO_DONO },
    })

    const { statusCode } = await submeter(cenario, ['mallory/autorizado'])

    expect(statusCode).toBe(200)
    expect(cenario.projetos).toHaveLength(1)
  })
})
