import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { LocalWorkspaceProvider } from '@gitorch/workspace-engine'
import { processDiagnosisJob, repoWorkspaceSlug } from '../services/free-diagnosis.js'
import { ClientEnvironmentService } from '../services/environment.js'
import { exportGraphIsolated } from '../services/graph-export.js'

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
  const clientEnvironments = new ClientEnvironmentService(app.prisma)
  // Sem repositório/token: allocateWorkspace só GARANTE o diretório (mkdir),
  // nunca clona — a rota do grafo é LEITURA do que o diagnóstico já deixou em
  // disco, nunca dispara um clone novo (mesmo raciocínio do "UM clone só" do
  // front: reusa o diagnóstico existente).
  const workspaceProvider = new LocalWorkspaceProvider()

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

      // Reaproveita o clone do ambiente (passo 4) se já existe — não clona 2x.
      const existingWorkspacePath = await clientEnvironments.repoPathInEnv(request.user.id, repo)

      // Fire-and-forget: o processamento não trava a resposta (clone+índice
      // leva de segundos a ~1min). processDiagnosisJob nunca lança — toda
      // falha vira status=failed no próprio job.
      void processDiagnosisJob(
        job.id,
        { userId: request.user.id, repoFullName: repo, githubToken },
        { prisma: app.prisma, ...(existingWorkspacePath ? { existingWorkspacePath } : {}) }
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

  // GET /api/v1/diagnose/:id/graph - Grafo 3D (nós+arestas) do repo já
  // diagnosticado (F1 — Onda 3, "momento mágico"). MESMA guarda de posse do
  // GET /:id acima: job de outro usuário e job inexistente caem no MESMO 404
  // (indistinguível — o mesmo raciocínio de AssistedLoginService.subscribe(),
  // pra não dar a um usuário autenticado um jeito de descobrir, por IDOR, se
  // um dado id de diagnóstico pertence a outra pessoa).
  app.get<{ Params: DiagnoseParams }>(
    '/api/v1/diagnose/:id/graph',
    async (request: FastifyRequest<{ Params: DiagnoseParams }>, reply: FastifyReply) => {
      if (!request.user) {
        return reply.code(401).send({ error: 'UNAUTHORIZED: session required' })
      }
      const job = await app.prisma.diagnosisJob.findFirst({
        where: { id: request.params.id, userId: request.user.id },
        select: { id: true, status: true, repoFullName: true },
      })
      if (!job) {
        return reply.code(404).send({ error: 'NOT_FOUND' })
      }
      if (job.status !== 'completed') {
        return reply.code(409).send({ error: 'DIAGNOSIS_NOT_READY' })
      }

      // NUNCA clona de novo: reusa o clone do ambiente (passo 4) se existir;
      // senão o próprio diretório diag-<repo> que o diagnóstico já deixou
      // (allocateWorkspace sem `repository` só garante o diretório, não clona).
      const existingWorkspacePath = await clientEnvironments.repoPathInEnv(
        request.user.id,
        job.repoFullName
      )
      const workspacePath =
        existingWorkspacePath ??
        (
          await workspaceProvider.allocateWorkspace(
            request.user.id,
            repoWorkspaceSlug(job.repoFullName)
          )
        ).path

      const graph = await exportGraphIsolated(workspacePath)
      if (!graph) {
        return reply.code(404).send({ error: 'GRAPH_UNAVAILABLE' })
      }
      return reply.send(graph)
    }
  )
}
