import { it, expect, describe, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import { loadEnv } from '../config/env.js'
import { registerPlugins } from '../plugins/index.js'
import { pipelineRoutes } from './pipeline-routes.js'

describe('Pipeline Routes', () => {
  let app: ReturnType<typeof Fastify>
  let authHeaders: { authorization: string }

  beforeEach(async () => {
    app = Fastify()
    const env = loadEnv()
    await registerPlugins(app, env)
    await app.register(pipelineRoutes)

    const token = jwt.sign({ userId: 'user_123', wingId: 'wing_123' }, env.JWT_SECRET)
    authHeaders = { authorization: `Bearer ${token}` }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.prisma.pipelineConfig = {} as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.prisma.pipelineEvidence = {} as any

    await app.ready()
  })

  describe('POST /api/v1/projects/:projectId/pipelines/analyze', () => {
    it('should return 404 if project does not exist', async () => {
      app.prisma.project.findUnique = vi.fn().mockResolvedValue(null)

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/non_existent/pipelines/analyze`,
        headers: authHeaders,
      })

      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'Project not found' })
    })

    it('should analyze and return pipeline config if project exists', async () => {
      const projectId = 'proj_123'
      const project = {
        id: projectId,
        name: 'Test Project',
        userId: 'user_123',
        wingId: 'wing_123',
      }

      app.prisma.project.findUnique = vi.fn().mockResolvedValue(project)
      const config = {
        projectId,
        lastScore: 85,
        lastAuditedAt: new Date(),
        detectedStack: { language: 'typescript', framework: 'fastify', database: 'postgres' },
      }
      app.prisma.pipelineConfig.upsert = vi.fn().mockResolvedValue(config)

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/pipelines/analyze`,
        headers: authHeaders,
      })

      expect(res.statusCode).toBe(200)
      const data = res.json()
      expect(data).toHaveProperty('config')
      expect(data).toHaveProperty('analysis')
      expect(data.config.projectId).toBe(projectId)
      expect(data.analysis.score).toBe(85)
    })
  })

  describe('POST /api/v1/projects/:projectId/pipelines/evidence', () => {
    it('should return 404 if PipelineConfig does not exist', async () => {
      app.prisma.pipelineConfig.findUnique = vi.fn().mockResolvedValue(null)

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/proj_123/pipelines/evidence`,
        headers: authHeaders,
        payload: {
          commitHash: 'abcdef123456',
          branch: 'main',
          status: 'passed',
          evidenceSummary: { coverage: 90 },
        },
      })

      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'PipelineConfig not found for project' })
    })

    it('should create and return pipeline evidence if config exists', async () => {
      const projectId = 'proj_123'
      const config = { id: 'config_123', projectId, lastScore: 85 }
      app.prisma.pipelineConfig.findUnique = vi.fn().mockResolvedValue(config)

      const payload = {
        commitHash: 'abcdef123456',
        branch: 'main',
        status: 'passed',
        evidenceSummary: { test_count: 10, passed: 10 },
      }

      const evidence = {
        id: 'ev_123',
        pipelineConfigId: config.id,
        commitHash: payload.commitHash,
        status: payload.status,
      }
      app.prisma.pipelineEvidence.create = vi.fn().mockResolvedValue(evidence)

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${projectId}/pipelines/evidence`,
        headers: authHeaders,
        payload,
      })

      expect(res.statusCode).toBe(201)
      const data = res.json()
      expect(data).toHaveProperty('evidence')
      expect(data.evidence.commitHash).toBe(payload.commitHash)
      expect(data.evidence.pipelineConfigId).toBe(config.id)
    })
  })
})
