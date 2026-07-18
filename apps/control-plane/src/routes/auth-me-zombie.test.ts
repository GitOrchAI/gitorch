import { describe, expect, it, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import jwt from 'jsonwebtoken'
import { resetEnvCache, getEnv } from '../config/env.js'
import { authPlugin } from '../plugins/auth.js'
import { authRoutes } from './auth.js'

/**
 * Sessão-zumbi: um cookie `gitorch_session` criptograficamente VÁLIDO (assinado
 * com o JWT_SECRET atual) pode apontar para um usuário que NÃO existe mais no
 * banco — troca/reset de banco, usuário apagado, ambiente recriado. O caso real
 * (18/07): o dono abriu o wizard com um cookie de dias atrás, /auth/me disse
 * "logado" sem consultar o banco, o wizard pulou o login, e o passo de
 * repositórios morreu com um 401 sem saída ("GitHub not connected") porque o
 * usuário do cookie nunca existiu neste banco.
 *
 * Contrato: /auth/me só diz "autenticado" se o usuário do cookie EXISTE no
 * banco. Se não existe, responde 401 e LIMPA o cookie — o front volta pro
 * login e a pessoa entra de verdade.
 */
describe('/api/v1/auth/me — sessão-zumbi (usuário do cookie não existe no banco)', () => {
  let app: ReturnType<typeof Fastify>

  const buildApp = async (findUniqueResult: unknown) => {
    process.env['GITHUB_CLIENT_ID'] = 'test-client-id'
    process.env['GITHUB_CLIENT_SECRET'] = 'test-client-secret'
    resetEnvCache()

    app = Fastify()
    await app.register(fastifyCookie)
    app.decorate('prisma', {
      user: {
        findUnique: vi.fn().mockResolvedValue(findUniqueResult),
      },
      apiKey: { findMany: vi.fn().mockResolvedValue([]) },
    } as never)
    await app.register(authPlugin)
    await authRoutes(app)
    await app.ready()
  }

  afterEach(async () => {
    await app.close()
    vi.restoreAllMocks()
  })

  const cookieFor = (userId: string) => {
    const env = getEnv()
    return jwt.sign({ userId, wingId: 'wing_x', email: 'x@example.test' }, env.JWT_SECRET, {
      expiresIn: '1h',
    })
  }

  it('cookie válido + usuário INEXISTENTE => 401 e cookie limpo', async () => {
    await buildApp(null)
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { gitorch_session: cookieFor('usuario-que-nao-existe') },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ error: expect.stringContaining('SESSION_STALE') })
    const setCookie = res.headers['set-cookie']
    expect(String(setCookie)).toContain('gitorch_session=')
    expect(String(setCookie)).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/)
  })

  it('cookie válido + usuário EXISTE => 200 authenticated', async () => {
    await buildApp({ id: 'user-real' })
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { gitorch_session: cookieFor('user-real') },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ authenticated: true, userId: 'user-real' })
  })

  it('sem cookie => 401 sem tocar no banco', async () => {
    await buildApp(null)
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me' })
    expect(res.statusCode).toBe(401)
  })
})
