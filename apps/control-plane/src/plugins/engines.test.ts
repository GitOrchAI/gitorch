import { describe, expect, it, vi, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import Fastify, { FastifyRequest } from 'fastify'
import { enginesPlugin } from './engines.js'
import { ssePlugin } from './sse.js'

describe('POST /api/v1/engines/:runtime/token', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    process.env['GITORCH_CREDENTIAL_KEY'] = randomBytes(32).toString('hex')
    app = Fastify()
    app.decorate('prisma', {
      user: { findUnique: vi.fn().mockResolvedValue({ id: 'user_1' }) },
      engineConnection: {
        upsert: vi.fn().mockResolvedValue({
          runtime: 'claude',
          status: 'connected',
          modelsRefreshedAt: null,
          lastValidatedAt: new Date(),
          lastError: null,
        }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'user_1', wingId: 'octocat', email: 'octocat@example.test' }
    })
    await app.register(enginesPlugin)
    await app.ready()
  })

  it('connects claude via a pasted setup-token (env credential)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/engines/claude/token',
      payload: { token: 'sk-ant-oat01-FAKE' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ connected: true })
    expect(app.prisma.engineConnection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ credentialKind: 'env' }),
      })
    )
    // O setup-token do Claude vale ~1 ano — sem gravar isso, expiresAt ficava
    // pra sempre null e a conexão nunca era detectada como vencida depois.
    const upsertCall = app.prisma.engineConnection.upsert.mock.calls[0]![0] as {
      update: { expiresAt?: Date }
    }
    expect(upsertCall.update.expiresAt).toBeInstanceOf(Date)
    expect(upsertCall.update.expiresAt!.getTime()).toBeGreaterThan(Date.now())
  })

  it('connects claude via the wizard\'s own product-name alias "claude-code" (same vocabulary setup/submit uses)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/engines/claude-code/token',
      payload: { token: 'sk-ant-oat01-FAKE' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ connected: true })
    // Precisa cair no caminho de credencial ENV (mesmo do runtime 'claude'),
    // não no connectFileCredential (que trataria como um arquivo do Codex).
    expect(app.prisma.engineConnection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ credentialKind: 'env' }),
      })
    )
  })

  it('connects codex via pasted auth.json content (file credential)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/engines/codex/token',
      // auth.json com a FORMA real (tokens.access_token) — a validação estrutural
      // do paste exige isso; um `{auth_mode:'chatgpt'}` pelado (sem token) é
      // rejeitado de propósito (era o "connected mentiroso" do QA 2026-07-13).
      payload: {
        token: JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'aaa.bbb.ccc' } }),
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ connected: true })
  })

  it('rejeita (400) um auth.json do codex grosseiramente falso — não vira connected (QA 2026-07-13)', async () => {
    // Regressão na camada HTTP: colar `{"fake":"x"}` no wizard devolvia
    // connected:true porque o `codex login status` mente (exit 0 p/ qualquer JSON).
    // Agora a validação de forma barra na porta → 400, e o upsert nunca roda.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/engines/codex/token',
      payload: { token: '{"fake":"qualquer coisa"}' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/codex inválida/)
    expect(app.prisma.engineConnection.upsert).not.toHaveBeenCalled()
  })

  it('connects antigravity via pasted oauth-token content (file credential)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/engines/antigravity/token',
      payload: { token: 'oauth-token-fake' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ connected: true })
  })

  it('B2: liveness reprova a credencial colada (upsert status:error) → connected:false, não true fixo', async () => {
    // A validação viva reprova o token colado: o upsert grava status 'error'.
    // A resposta NÃO pode dizer connected:true (fachada) — reflete o real.
    const upsertMock = app.prisma.engineConnection.upsert as unknown as {
      mockResolvedValue: (value: unknown) => void
    }
    upsertMock.mockResolvedValue({
      runtime: 'claude',
      status: 'error',
      modelsRefreshedAt: null,
      lastValidatedAt: null,
      lastError: 'motor não respondeu à validação viva',
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/engines/claude/token',
      payload: { token: 'sk-ant-oat01-FAKE' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ connected: false, status: { status: 'error' } })
  })

  it('rejects an unsupported runtime with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/engines/nonsense/token',
      payload: { token: 'whatever' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a missing token with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/engines/claude/token',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 401 without a session', async () => {
    const noSessionApp = Fastify()
    noSessionApp.decorate('prisma', {
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    await noSessionApp.register(enginesPlugin)
    await noSessionApp.ready()

    const res = await noSessionApp.inject({
      method: 'POST',
      url: '/api/v1/engines/claude/token',
      payload: { token: 'x' },
    })
    expect(res.statusCode).toBe(401)
  })
})

// Fake do handle de `runDeviceLogin` (mesmo shape usado em
// services/assisted-login.test.ts) — evita disparar um container podman de
// verdade num teste unitário. Injetado via `runDeviceLoginImpl` (seam de
// teste adicionada ao plugin só para isto).
function fakeHandle() {
  const emitter = new EventEmitter()
  let resolveExited: (v: { code: number | null }) => void = () => undefined
  const exited = new Promise<{ code: number | null }>((r) => {
    resolveExited = r
  })
  const handle = {
    hostHome: '/tmp/gitorch-engines-test-login',
    onStdout: (cb: (chunk: string) => void) => emitter.on('stdout', cb),
    writeStdin: vi.fn(),
    exited,
    kill: vi.fn(),
  }
  return {
    handle,
    emitStdout: (chunk: string) => emitter.emit('stdout', chunk),
    emitExit: (code: number | null) => resolveExited({ code }),
  }
}

describe('login assistido (start / code / stream)', () => {
  let app: ReturnType<typeof Fastify>
  let fake: ReturnType<typeof fakeHandle>
  let runDeviceLoginImpl: ReturnType<typeof vi.fn>
  // Mutável (em vez de fixado no hook): o teste de IDOR abaixo troca quem
  // está "autenticado" ENTRE duas requisições na MESMA instância do app —
  // ou seja, no mesmo AssistedLoginService/mesmas sessões em memória —
  // pra simular um segundo usuário tentando acessar o loginId do primeiro.
  let currentUser: { id: string; wingId: string; email: string }

  beforeEach(async () => {
    process.env['GITORCH_CREDENTIAL_KEY'] = randomBytes(32).toString('hex')
    // O login assistido resolve o ambiente isolado do user (HOME onde a
    // credencial vive): base de ambientes num tmp dir writable, senão o mkdir
    // 0700 do createProvisional falharia no CI.
    process.env['GITORCH_ENVIRONMENTS_DIR'] = mkdtempSync(join(tmpdir(), 'gitorch-engines-env-'))
    fake = fakeHandle()
    runDeviceLoginImpl = vi.fn().mockReturnValue(fake.handle)
    currentUser = { id: 'user_1', wingId: 'octocat', email: 'octocat@example.test' }
    app = Fastify()
    app.decorate('prisma', {
      user: {
        // Resolve por email (não mais um valor fixo): o teste de IDOR precisa
        // que um segundo email autenticado ('attacker@example.test') resolva
        // pra um userId DIFERENTE ('user_2') do dono da sessão ('user_1').
        findUnique: vi
          .fn()
          .mockImplementation(async ({ where }: { where: { email: string } }) =>
            where.email === 'attacker@example.test' ? { id: 'user_2' } : { id: 'user_1' }
          ),
      },
      engineConnection: {
        upsert: vi.fn(),
        findMany: vi.fn().mockResolvedValue([]),
      },
      // createProvisional: sem provisório aberto (findFirst null) cria um novo
      // e devolve o registro com o `path` (o dir do ambiente que vira o HOME
      // do login). update ecoa o path que o serviço calculou.
      clientEnvironment: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'env_test' }),
        update: vi.fn().mockImplementation(async ({ data }: { data: { path: string } }) => ({
          id: 'env_test',
          userId: 'user_1',
          status: 'provisional',
          path: data.path,
        })),
        // touch(): renova o relógio da faxina a cada atividade real do wizard.
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = currentUser
    })
    await app.register(ssePlugin)
    await app.register(enginesPlugin, { runDeviceLoginImpl })
    await app.ready()
  })

  it('POST /api/v1/engines/:runtime/login/start inicia um login assistido e retorna loginId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/engines/codex/login/start',
    })
    expect(res.statusCode).toBe(202)
    expect(JSON.parse(res.body)).toHaveProperty('loginId')
    expect(runDeviceLoginImpl).toHaveBeenCalledWith(expect.objectContaining({ binary: 'codex' }))
  })

  it('POST /api/v1/engines/:runtime/login/start: o login usa o HOME do ambiente do user (credenciais vivem ali)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/engines/codex/login/start',
    })
    expect(res.statusCode).toBe(202)

    // O ambiente isolado (0700) do user vira o HOME do container de login:
    // makeHomeImpl aponta pro dir do ambiente, não pra um mkdtemp efêmero — a
    // credencial que o CLI grava fica DENTRO do ambiente, protegida, e a
    // faxina 24h a destrói se o wizard for abandonado.
    const opts = runDeviceLoginImpl.mock.calls[0]![0] as { makeHomeImpl?: () => string }
    expect(opts.makeHomeImpl).toBeTypeOf('function')
    const expectedHome = join(process.env['GITORCH_ENVIRONMENTS_DIR']!, 'env_test')
    expect(opts.makeHomeImpl!()).toBe(expectedHome)
  })

  it('POST /login/start: o ambiente é chaveado por request.user.id (JWT) — MESMA base do ciclo em setup.ts — não pelo id do banco', async () => {
    // Diverge o id do JWT (request.user.id) do id do banco (findUnique por
    // email → 'user_1' no beforeEach): sem o alinhamento, o login criaria um
    // ambiente sob o id do banco, separado do que os termos/clone/fix criam
    // sob o id do JWT — e a faxina 24h apagaria o do login (com a credencial).
    currentUser = { id: 'jwt-stale-id', wingId: 'octocat', email: 'octocat@example.test' }

    const res = await app.inject({ method: 'POST', url: '/api/v1/engines/codex/login/start' })
    expect(res.statusCode).toBe(202)

    // createProvisional (→ findFirst) resolve o ambiente pelo id do JWT.
    expect(app.prisma.clientEnvironment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'jwt-stale-id', status: 'provisional' } })
    )
  })

  it('POST /api/v1/engines/:runtime/login/start aceita o alias "claude-code" (mesmo vocabulário do paste-token)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/engines/claude-code/login/start',
    })
    expect(res.statusCode).toBe(202)
    expect(runDeviceLoginImpl).toHaveBeenCalledWith(expect.objectContaining({ binary: 'claude' }))
  })

  it('POST /api/v1/engines/:runtime/login/start rejeita runtime desconhecido', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/engines/bogus/login/start',
    })
    expect(res.statusCode).toBe(400)
    expect(runDeviceLoginImpl).not.toHaveBeenCalled()
  })

  it('POST /api/v1/engines/:runtime/login/start exige sessão', async () => {
    const noSessionApp = Fastify()
    noSessionApp.decorate('prisma', {
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    await noSessionApp.register(enginesPlugin)
    await noSessionApp.ready()

    const res = await noSessionApp.inject({
      method: 'POST',
      url: '/api/v1/engines/codex/login/start',
    })
    expect(res.statusCode).toBe(401)
  })

  it('POST /api/v1/engines/login/:loginId/code exige sessão', async () => {
    const noSessionApp = Fastify()
    noSessionApp.decorate('prisma', {
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    await noSessionApp.register(enginesPlugin)
    await noSessionApp.ready()

    const res = await noSessionApp.inject({
      method: 'POST',
      url: '/api/v1/engines/login/any-id/code',
      payload: { code: 'x' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('POST /api/v1/engines/login/:loginId/code exige o campo code', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/v1/engines/claude/login/start' })
    const { loginId } = JSON.parse(start.body) as { loginId: string }

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/engines/login/${loginId}/code`,
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/v1/engines/login/:loginId/code repassa o código pro stdin do container', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/v1/engines/claude/login/start' })
    const { loginId } = JSON.parse(start.body) as { loginId: string }

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/engines/login/${loginId}/code`,
      payload: { code: '  the-code  ' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    // runtime PTY → Enter é '\r' (ver submitCode); código e Enter vão em
    // writeStdin SEPARADOS (BUG 1, diagnóstico 20/07) — o Enter chega num
    // segundo write, após um pequeno delay.
    expect(fake.handle.writeStdin).toHaveBeenCalledWith('the-code')
    await vi.waitFor(() => {
      expect(fake.handle.writeStdin).toHaveBeenCalledWith('\r')
    })
  })

  it('POST /api/v1/engines/login/:loginId/code com loginId desconhecido retorna 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/engines/login/does-not-exist/code',
      payload: { code: 'x' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toHaveProperty('error')
  })

  it('colar o código RENOVA o relógio da faxina (concluir o login é atividade real)', async () => {
    // Concluir o login é o passo do wizard que NÃO passa pelo createProvisional.
    // Sem renovar aqui, um cliente a quem só faltasse colar o código podia ter o
    // ambiente varrido pelo GC — com a credencial que o CLI acabou de gravar.
    const start = await app.inject({ method: 'POST', url: '/api/v1/engines/claude/login/start' })
    const { loginId } = JSON.parse(start.body) as { loginId: string }

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/engines/login/${loginId}/code`,
      payload: { code: 'the-code' },
    })

    expect(res.statusCode).toBe(200)
    // Escopado ao ambiente provisório DAQUELE dono (id do JWT), nunca ao fixado
    // nem ao de outro cliente.
    expect(app.prisma.clientEnvironment.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user_1', status: 'provisional' },
      data: { lastActivityAt: expect.any(Date) },
    })
  })

  it('GET /api/v1/engines/login/:loginId retorna o estado atual em JSON puro (fallback de polling, sem SSE)', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/v1/engines/codex/login/start' })
    const { loginId } = JSON.parse(start.body) as { loginId: string }

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/engines/login/${loginId}`,
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ phase: 'starting' })
  })

  it('GET /api/v1/engines/login/:loginId exige sessão', async () => {
    const noSessionApp = Fastify()
    noSessionApp.decorate('prisma', {
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    await noSessionApp.register(enginesPlugin)
    await noSessionApp.ready()

    const res = await noSessionApp.inject({
      method: 'GET',
      url: '/api/v1/engines/login/any-id',
    })
    expect(res.statusCode).toBe(401)
  })

  it('GET /api/v1/engines/login/:loginId com loginId desconhecido retorna 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/engines/login/does-not-exist',
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'sessão de login não encontrada' })
  })

  it('IDOR: outro usuário autenticado recebe 404 (não o estado alheio) ao consultar loginId de quem não é dono', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/v1/engines/claude/login/start' })
    const { loginId } = JSON.parse(start.body) as { loginId: string }

    currentUser = { id: 'user_2', wingId: 'attacker', email: 'attacker@example.test' }
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/engines/login/${loginId}`,
    })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toEqual({ error: 'sessão de login não encontrada' })

    // Guarda de regressão: o dono legítimo continua conseguindo consultar.
    currentUser = { id: 'user_1', wingId: 'octocat', email: 'octocat@example.test' }
    const ownerRes = await app.inject({
      method: 'GET',
      url: `/api/v1/engines/login/${loginId}`,
    })
    expect(ownerRes.statusCode).toBe(200)
  })

  it('GET /api/v1/engines/login/:loginId/stream exige sessão', async () => {
    const noSessionApp = Fastify()
    noSessionApp.decorate('prisma', {
      user: { findUnique: vi.fn().mockResolvedValue(null) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    await noSessionApp.register(ssePlugin)
    await noSessionApp.register(enginesPlugin)
    await noSessionApp.ready()

    const res = await noSessionApp.inject({
      method: 'GET',
      url: '/api/v1/engines/login/any-id/stream',
    })
    expect(res.statusCode).toBe(401)
  })

  it('GET /api/v1/engines/login/:loginId/stream com loginId desconhecido retorna 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/engines/login/does-not-exist/stream',
    })
    expect(res.statusCode).toBe(404)
    // Não basta o status: uma rota inexistente também cai em 404 (default do
    // Fastify) — checar o corpo garante que é o nosso handler (loginId não
    // encontrado), não a rota faltando.
    expect(JSON.parse(res.body)).toEqual({ error: 'sessão de login não encontrada' })
  })

  it('IDOR: outro usuário autenticado não consegue nem submeter código nem abrir o stream do loginId de quem não é dono', async () => {
    // Usuário A (dono) inicia o login normalmente.
    const start = await app.inject({ method: 'POST', url: '/api/v1/engines/claude/login/start' })
    const { loginId } = JSON.parse(start.body) as { loginId: string }

    // Troca o usuário autenticado nesta MESMA app (mesma instância do
    // AssistedLoginService) para o atacante ('user_2') antes das próximas
    // requisições — sem reiniciar o app nem o container fake.
    currentUser = { id: 'user_2', wingId: 'attacker', email: 'attacker@example.test' }

    // (a) POST /code: pré-fix isto retornaria 200 e escreveria o código do
    // atacante no stdin do container do usuário A (o cenário de
    // confused-deputy do finding). Pós-fix, cai no mesmo ramo de "sessão não
    // encontrada" que loginId inexistente — mesmo status e mesma mensagem,
    // sem distinguir "não existe" de "não é seu".
    const codeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/engines/login/${loginId}/code`,
      payload: { code: 'stolen-from-attackers-own-oauth-approval' },
    })
    expect(codeRes.statusCode).toBe(400)
    expect(JSON.parse(codeRes.body)).toEqual({ error: 'sessão de login não encontrada' })
    expect(fake.handle.writeStdin).not.toHaveBeenCalled()

    // (b) GET /stream: pré-fix isto retornaria 200 e passaria a emitir o
    // estado de login do usuário A pro atacante (vazamento de informação).
    // Pós-fix, `subscribe` retorna null igual a loginId inexistente, então a
    // rota cai no mesmo 404 já existente — nenhuma lógica nova na rota.
    const streamRes = await app.inject({
      method: 'GET',
      url: `/api/v1/engines/login/${loginId}/stream`,
    })
    expect(streamRes.statusCode).toBe(404)
    expect(JSON.parse(streamRes.body)).toEqual({ error: 'sessão de login não encontrada' })

    // Guarda de regressão: o dono legítimo ('user_1') continua conseguindo
    // usar as duas rotas na mesma sessão depois da tentativa do atacante.
    currentUser = { id: 'user_1', wingId: 'octocat', email: 'octocat@example.test' }
    const ownerCodeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/engines/login/${loginId}/code`,
      payload: { code: 'the-real-code' },
    })
    expect(ownerCodeRes.statusCode).toBe(200)
    // runtime PTY → Enter é '\r' (ver submitCode); código e Enter em writeStdin
    // SEPARADOS (BUG 1) — o Enter chega num segundo write, após um pequeno delay.
    expect(fake.handle.writeStdin).toHaveBeenCalledWith('the-real-code')
    await vi.waitFor(() => {
      expect(fake.handle.writeStdin).toHaveBeenCalledWith('\r')
    })
  })
})
