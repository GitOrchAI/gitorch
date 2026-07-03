import { test, expect, describe, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import { loadEnv } from '../config/env.js'
import { registerPlugins } from '../plugins/index.js'
import { projectRoutes } from './projects.js'
import { runtimeConfigRoutes } from './runtime-config.js'

describe('Project Routes', () => {
  let app: ReturnType<typeof Fastify>
  let authHeaders: { authorization: string }

  beforeEach(async () => {
    app = Fastify()
    const env = loadEnv()
    await registerPlugins(app, env)
    await projectRoutes(app)
    await runtimeConfigRoutes(app)

    // Autentica pelo fluxo real (JWT assinado com o segredo do ambiente):
    // o hook de auth é global e rejeita requisições sem Bearer válido.
    const token = jwt.sign({ userId: 'user_123', wingId: 'wing_123' }, env.JWT_SECRET)
    authHeaders = { authorization: `Bearer ${token}` }

    await app.ready()
  })

  test('GET /api/projects returns projects list', async () => {
    app.prisma.project.findMany = vi.fn().mockResolvedValue([{ id: 'proj_456', name: 'Test' }])
    app.prisma.project.count = vi.fn().mockResolvedValue(1)

    const res = await app.inject({ method: 'GET', url: '/api/projects', headers: authHeaders })

    expect(res.statusCode).toBe(200)
    expect(res.json().data).toHaveLength(1)
  })

  test('PATCH /api/projects/:id/runtime-config updates config', async () => {
    app.prisma.project.findFirst = vi.fn().mockResolvedValue({ id: 'proj_456', wingId: 'wing_123' })
    app.prisma.project.update = vi.fn().mockResolvedValue({
      id: 'proj_456',
      name: 'Test',
      runtimeConfig: { model: 'gpt-4' },
    })

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/projects/proj_456/runtime-config',
      headers: authHeaders,
      payload: { runtimeConfig: { model: 'gpt-4' } },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().runtimeConfig).toEqual({ model: 'gpt-4' })
  })
})
