import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { processDiagnosisJob } from '../services/free-diagnosis.js'

interface DiagnoseBody {
  repo: string
}
interface DiagnoseParams {
  id: string
}

// Job "vivo" (pending/running) reaproveitado dentro desta janela: evita
// clonar 2x se a pessoa clicar de novo ou voltar/avançar no wizard.
const REUSE_WINDOW_MS = 10 * 60 * 1000

export const diagnoseRoutes = async (app: FastifyInstance): Promise<void> => {
  // POST /api/v1/diagnose - Dispara o diagnóstico grátis (F1, zero-LLM) de um
  // repo escolhido no wizard. Roda ANTES de existir Project/pagamento — por
  // isso é DiagnosisJob, não Mission. Responde na hora (não espera o clone).
  app.post<{ Body: DiagnoseBody }>(
    '/api/v1/diagnose',
    {
      config: {
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
    },
    async (request: FastifyRequest<{ Body: DiagnoseBody }>, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'UNAUTHORIZED: session required' })
      }
      if (!app.engineConnections) {
        return reply.code(500).send({ error: 'Engine connections service unavailable' })
      }
      const { repo } = request.body
      if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
        return reply.code(400).send({ error: 'INVALID_REPO: expected "owner/repo"' })
      }

      const githubToken = await app.engineConnections.getRawGithubToken(request.user.id)
      if (!githubToken) {
        return reply.code(401).send({ error: 'UNAUTHORIZED: GitHub not connected' })
      }

      const existing = await app.prisma.diagnosisJob.findFirst({
        where: {
          userId: request.user.id,
          repoFullName: repo,
          OR: [
            { status: { in: ['pending', 'running'] } },
            {
              status: 'completed',
              completedAt: { gt: new Date(Date.now() - REUSE_WINDOW_MS) },
            },
          ],
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true },
      })
      if (existing) {
        return reply.send({ id: existing.id, status: existing.status })
      }

      const job = await app.prisma.diagnosisJob.create({
        data: { userId: request.user.id, repoFullName: repo, status: 'pending' },
        select: { id: true, status: true },
      })

      // Fire-and-forget: o processamento não trava a resposta (clone+índice
      // leva de segundos a ~1min). processDiagnosisJob nunca lança — toda
      // falha vira status=failed no próprio job.
      void processDiagnosisJob(
        job.id,
        { userId: request.user.id, repoFullName: repo, githubToken },
        { prisma: app.prisma }
      )

      return reply.code(202).send({ id: job.id, status: job.status })
    }
  )

  // GET /api/v1/diagnose/:id - Status/resultado do diagnóstico (polling).
  app.get<{ Params: DiagnoseParams }>(
    '/api/v1/diagnose/:id',
    async (request: FastifyRequest<{ Params: DiagnoseParams }>, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'UNAUTHORIZED: session required' })
      }
      const job = await app.prisma.diagnosisJob.findFirst({
        where: { id: request.params.id, userId: request.user.id },
        select: {
          id: true,
          status: true,
          progress: true,
          result: true,
          error: true,
          repoFullName: true,
        },
      })
      if (!job) {
        return reply.code(404).send({ error: 'NOT_FOUND' })
      }
      return reply.send(job)
    }
  )
}
