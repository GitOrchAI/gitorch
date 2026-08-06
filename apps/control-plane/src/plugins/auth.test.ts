import { describe, expect, it, beforeEach, vi } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import jwt from 'jsonwebtoken'
import { authPlugin } from './auth.js'
import { prisma } from './prisma.js'
import rateLimit from '@fastify/rate-limit'

// Mesmo segredo que src/test/setup.ts injeta globalmente — getEnv() cacheia
// no primeiro uso, então sobrescrever process.env aqui não teria efeito.
const JWT_SECRET = 'test-secret-key-that-is-at-least-32-characters-long'

describe('Auth Plugin', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    app = Fastify()
    await app.register(fastifyCookie)
    await app.register(rateLimit)
    await app.register(authPlugin)
    app.get('/api/projects', async (request: FastifyRequest) => ({
      projects: [],
      user: request.user ?? null,
    }))
    app.get('/health', async () => ({ status: 'ok' }))
    app.get('/ready', async () => ({ status: 'ready' }))
    app.get('/metrics', async () => 'metrics')
    app.post('/api/webhooks/github', async () => ({ ok: true }))
    // Front estático servido pela MESMA origem: paths fora de /api são públicos.
    app.get('/setup', async () => 'wizard-html')
    app.get('/_next/static/app.js', async () => 'asset')
    await app.ready()
    // O hook passou a conferir se o dono da sessão ainda existe (sessão de
    // usuário apagado virava 500 nas rotas). Por padrão, aqui ele existe.
    ;(prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'user-123' })
  })

  it('skips auth for public paths', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
  })

  it('serves the same-origin static front (non-/api paths) without auth, keeps /api protected', async () => {
    // Sem isso o auth hook devolveria 401 nos próprios arquivos do site,
    // impedindo o wizard de carregar quando servido pela mesma origem da API.
    expect((await app.inject({ method: 'GET', url: '/setup' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/_next/static/app.js' })).statusCode).toBe(200)
    // …mas a superfície de API sob /api continua protegida.
    expect((await app.inject({ method: 'GET', url: '/api/projects' })).statusCode).toBe(401)
  })

  it('skips auth for metrics endpoint', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
  })

  it('skips auth for ready endpoint', async () => {
    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(200)
  })

  it('skips auth for webhook endpoint', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/webhooks/github' })
    expect(res.statusCode).toBe(200)
  })

  it('authenticates via gitorch_session cookie when no Authorization header is present', async () => {
    const token = jwt.sign({ userId: 'user_1', wingId: 'wing_1' }, JWT_SECRET)
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      cookies: { gitorch_session: token },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().user).toMatchObject({ id: 'user_1', wingId: 'wing_1' })
  })

  it('rejects an invalid gitorch_session cookie with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      cookies: { gitorch_session: 'not-a-valid-jwt' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('prefers Authorization header over cookie when both are present', async () => {
    const cookieToken = jwt.sign({ userId: 'cookie_user', wingId: 'wing_cookie' }, JWT_SECRET)
    const headerToken = jwt.sign({ userId: 'header_user', wingId: 'wing_header' }, JWT_SECRET)
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      cookies: { gitorch_session: cookieToken },
      headers: { authorization: `Bearer ${headerToken}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().user).toMatchObject({ id: 'header_user' })
  })
})

// Visto ao vivo: depois de o ambiente do dono ser zerado, a aba antiga do
// funil ainda carregava o cookie de sessão. O token continua com assinatura
// válida (nada o invalidou), mas o usuário não existe mais — e a rota tentava
// criar ambiente para um dono fantasma, estourando em 500 com violação de
// chave estrangeira. Para quem está usando, é "deu erro do nada".
//
// A checagem de existência já existia, mas só em /auth/me. O lugar certo é o
// hook: qualquer rota de sessão devolve 401 e limpa o cookie, e a pessoa volta
// para o login em vez de bater num erro de servidor.
describe('sessão de usuário que não existe mais', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    app = Fastify()
    await app.register(fastifyCookie)
    await app.register(rateLimit)
    await app.register(authPlugin)
    app.get('/api/projects', async (request: FastifyRequest) => ({
      projects: [],
      user: request.user ?? null,
    }))
    await app.ready()
  })

  const cookieDe = (userId: string): string =>
    `gitorch_session=${jwt.sign({ userId, wingId: 'dono/repo' }, JWT_SECRET, { expiresIn: '7d' })}`

  it('devolve 401 e limpa o cookie, em vez de deixar a rota estourar em 500', async () => {
    ;(prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)

    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: cookieDe('usuario_apagado') },
    })

    expect(res.statusCode).toBe(401)
    expect(res.body).toContain('SESSION_STALE')
    expect(String(res.headers['set-cookie'] ?? '')).toContain('gitorch_session=')
  })

  it('usuário que existe segue entrando normalmente', async () => {
    ;(prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'usuario_vivo',
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: cookieDe('usuario_vivo') },
    })

    expect(res.statusCode).toBe(200)
  })
})
