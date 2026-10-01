import { FastifyPluginAsync } from 'fastify'

export const pipelineRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/v1/projects/:projectId/pipelines/analyze
  app.post<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/pipelines/analyze',
    async (request, reply) => {
      const { projectId } = request.params
      const project = await app.prisma.project.findUnique({ where: { id: projectId } })
      if (!project) return reply.code(404).send({ error: 'Project not found' })

      // Simula/executa análise do repositório
      // Salva ou atualiza PipelineConfig
      const config = await app.prisma.pipelineConfig.upsert({
        where: { projectId },
        create: {
          projectId,
          lastScore: 85,
          lastAuditedAt: new Date(),
          detectedStack: { language: 'typescript', framework: 'fastify', database: 'postgres' },
        },
        update: {
          lastScore: 85,
          lastAuditedAt: new Date(),
          detectedStack: { language: 'typescript', framework: 'fastify', database: 'postgres' },
        },
      })

      return reply.code(200).send({
        config,
        analysis: {
          score: 85,
          findings: [],
          recommendedStages: ['Fast CI', 'Preview Environment', 'CD'],
        },
      })
    }
  )

  // POST /api/v1/projects/:projectId/pipelines/propose
  // Adicionado só pra deixar como placeholder futuro (opcional pelo contexto original)
  app.post<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/pipelines/propose',
    async (request, reply) => {
      const { projectId } = request.params
      const config = await app.prisma.pipelineConfig.findUnique({ where: { projectId } })
      if (!config) return reply.code(404).send({ error: 'PipelineConfig not found for project' })
      return reply.code(200).send({ status: 'proposed' })
    }
  )

  // POST /api/v1/projects/:projectId/pipelines/evidence
  app.post<{
    Params: { projectId: string }
    Body: {
      commitHash: string
      branch: string
      status: string
      evidenceSummary: Record<string, unknown>
      eventSource?: string
      runId?: string
    }
  }>('/api/v1/projects/:projectId/pipelines/evidence', async (request, reply) => {
    const { projectId } = request.params
    const { commitHash, branch, status, evidenceSummary, eventSource, runId } = request.body

    const config = await app.prisma.pipelineConfig.findUnique({ where: { projectId } })
    if (!config) return reply.code(404).send({ error: 'PipelineConfig not found for project' })

    const evidence = await app.prisma.pipelineEvidence.create({
      data: {
        pipelineConfigId: config.id,
        commitHash,
        branch,
        status,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        evidenceSummary: evidenceSummary as any,
        eventSource: eventSource || 'github_actions',
        runId: runId || 'unknown_run_id',
      },
    })

    return reply.code(201).send({ evidence })
  })
}
