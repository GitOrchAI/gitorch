import { test, expect, describe, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { loadEnv } from '../config/env.js'
import { registerPlugins } from '../plugins/index.js'
import { projectRoutes } from './projects.js'

describe('Project Routes', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    app = Fastify()
    const env = loadEnv()
    await registerPlugins(app, env)
    await projectRoutes(app)
    
    app.addHook('onRequest', async (req: any) => {
      req.user = { wingId: 'wing_123', projectId: 'proj_456' }
      req.wingId = 'wing_123'
    })
    
    await app.ready()
  })

  test('GET /api/projects returns projects list', async () => {
    app.prisma.project.findMany = vi.fn().mockResolvedValue([{ id: 'proj_456', name: 'Test' }])
    app.prisma.project.count = vi.fn().mockResolvedValue(1)

    const res = await app.inject({ method: 'GET', url: '/api/projects' })

    expect(res.statusCode).toBe(200)
    expect(res.json().data).toHaveLength(1)
  })

  test('PATCH /api/projects/:id/runtime-config updates config', async () => {
    app.prisma.project.findFirst = vi.fn().mockResolvedValue({ id: 'proj_456', wingId: 'wing_123' })
    app.prisma.project.update = vi.fn().mockResolvedValue({
      id: 'proj_456',
      name: 'Test',
      runtimeConfig: { model: 'gpt-4' }
    })

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/projects/proj_456/runtime-config',
      payload: { runtimeConfig: { model: 'gpt-4' } }
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().runtimeConfig).toEqual({ model: 'gpt-4' })
  })
})
