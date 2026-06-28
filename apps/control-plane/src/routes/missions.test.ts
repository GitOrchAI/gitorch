import { test, expect, describe, vi, beforeEach } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import { loadEnv } from '../config/env.js'
import { registerPlugins } from '../plugins/index.js'
import { missionRoutes } from './missions.js'
import { eventRoutes } from './events.js'

describe('Mission and Event Routes', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    app = Fastify()
    const env = loadEnv()
    await registerPlugins(app, env)
    await missionRoutes(app)
    await eventRoutes(app)

    app.addHook('onRequest', async (req: FastifyRequest) => {
      // @ts-expect-error - mock authentication
      req.user = { wingId: 'wing_123', projectId: 'proj_456' }
      req.wingId = 'wing_123'
    })

    await app.ready()
  })

  test('POST /api/missions/trigger should create mission', async () => {
    app.prisma.project.findFirst = vi.fn().mockResolvedValue({ id: 'proj_456', name: 'Test' })
    app.prisma.mission.create = vi.fn().mockResolvedValue({
      id: 'mission_1',
      projectId: 'proj_456',
      type: 'sync',
      status: 'pending',
      payload: {},
      createdAt: new Date(),
    })
    app.broadcastEvent = vi.fn()

    const res = await app.inject({
      method: 'POST',
      url: '/api/missions/trigger',
      payload: { projectId: 'proj_456', type: 'sync', payload: {} },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().id).toBe('mission_1')
    expect(app.broadcastEvent).toHaveBeenCalled()
  })
})
