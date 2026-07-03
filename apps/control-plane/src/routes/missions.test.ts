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

  test('POST /api/missions/agent-run returns 202 with missionId when triggered', async () => {
    const trigger = vi.fn().mockResolvedValue({ triggered: true, missionId: 'mission_9' })
    app.triggerAgentMission = trigger

    const res = await app.inject({
      method: 'POST',
      url: '/api/missions/agent-run',
      payload: { role: 'ra' },
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ triggered: true, role: 'ra', missionId: 'mission_9' })
    expect(trigger).toHaveBeenCalledWith('ra')
  })

  test('POST /api/missions/agent-run returns 409 when the scheduler skips (busy/budget)', async () => {
    const trigger = vi.fn().mockResolvedValue({ triggered: false, reason: 'busy' })
    app.triggerAgentMission = trigger

    const res = await app.inject({
      method: 'POST',
      url: '/api/missions/agent-run',
      payload: { role: 'ra' },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ triggered: false, role: 'ra', reason: 'busy' })
  })

  test('POST /api/missions/agent-run rejects an unknown role', async () => {
    const trigger = vi.fn().mockResolvedValue({ triggered: false })
    app.triggerAgentMission = trigger

    const res = await app.inject({
      method: 'POST',
      url: '/api/missions/agent-run',
      payload: { role: 'hacker' },
    })

    expect(res.statusCode).toBe(400)
    expect(trigger).not.toHaveBeenCalled()
  })
})
