import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'

export interface RecordEvidenceOptions {
  apiUrl?: string
  projectId?: string
  commitHash?: string
  branch?: string
  status?: string
  evidenceSummary?: Record<string, unknown>
  eventSource?: string
  runId?: string
  token?: string
}

export async function recordPipelineEvidence(options: RecordEvidenceOptions = {}) {
  const apiUrl = options.apiUrl || process.env.GITORCH_API_URL || 'http://127.0.0.1:4012'
  let targetProjectId = options.projectId || process.env.PROJECT_ID || 'proj_ci_staging'
  let targetUserId = 'ci-service-user'

  const commitHash =
    options.commitHash || process.env.GITHUB_SHA || process.env.COMMIT_HASH || 'local-test-commit'
  const branch =
    options.branch ||
    process.env.GITHUB_REF_NAME ||
    process.env.BRANCH ||
    'feat/pipeline-intelligence'
  const status = options.status || 'passed'
  const eventSource = options.eventSource || 'github_actions'
  const runId = options.runId || process.env.GITHUB_RUN_ID || `run-${Date.now()}`
  const evidenceSummary = options.evidenceSummary || {
    pipelineScore: 100,
    fastCi: 'passed',
    ephemeralStaging: 'passed',
    unitTests: 'passed',
    securityScan: 'passed',
  }

  // Se DATABASE_URL estiver configurada, seleciona ou prepara o projeto compatível com tenant isolation
  if (process.env.DATABASE_URL) {
    const prisma = new PrismaClient()
    try {
      const existingProject = await prisma.project.findFirst({
        orderBy: { id: 'desc' },
      })

      if (existingProject && !options.projectId) {
        targetProjectId = existingProject.id
        if (existingProject.userId) {
          targetUserId = existingProject.userId
        }
      } else {
        const user = await prisma.user.upsert({
          where: { email: 'ci@gitorch.ai' },
          create: {
            id: targetUserId,
            email: 'ci@gitorch.ai',
            name: 'CI Staging User',
            githubLogin: `gitorch-ci-${Date.now()}`,
          },
          update: {},
        })
        targetUserId = user.id

        const project = await prisma.project.upsert({
          where: { id: targetProjectId },
          create: {
            id: targetProjectId,
            wingId: `GitOrchAI/gitorch-ci-${Date.now()}`,
            name: 'GitOrch CI Staging',
            userId: targetUserId,
          },
          update: {
            userId: targetUserId,
          },
        })
        targetProjectId = project.id
      }
    } catch (dbErr) {
      console.warn('[recordPipelineEvidence] Aviso ao checar banco direto:', dbErr)
    } finally {
      await prisma.$disconnect()
    }
  }

  let authToken = options.token || process.env.GITORCH_API_TOKEN
  if (!authToken && process.env.JWT_SECRET) {
    try {
      authToken = jwt.sign(
        { userId: targetUserId, wingId: 'GitOrchAI/gitorch' },
        process.env.JWT_SECRET
      )
    } catch (tokenErr) {
      console.warn('[recordPipelineEvidence] Erro ao assinar JWT com JWT_SECRET:', tokenErr)
    }
  }

  const authHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  }

  // Aciona primeiro /analyze para inicializar ou atualizar o PipelineConfig
  const analyzeEndpoint = `${apiUrl}/api/v1/projects/${targetProjectId}/pipelines/analyze`
  const analyzeRes = await fetch(analyzeEndpoint, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({}),
  })

  if (!analyzeRes.ok) {
    const errText = await analyzeRes.text()
    console.warn(`[recordPipelineEvidence] /analyze retornou HTTP ${analyzeRes.status}: ${errText}`)
  }

  // Aciona o endpoint de registro de evidência
  const endpoint = `${apiUrl}/api/v1/projects/${targetProjectId}/pipelines/evidence`
  const payload = {
    commitHash,
    branch,
    status,
    evidenceSummary,
    eventSource,
    runId,
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to record pipeline evidence: HTTP ${response.status} - ${errorText}`)
  }

  const data = await response.json()
  return data
}

if (import.meta.url.endsWith(process.argv[1] || '')) {
  console.log('Gravando evidencia de execucao de pipeline no control-plane...')
  recordPipelineEvidence()
    .then((result) => {
      console.log('Evidencia registrada com sucesso:', JSON.stringify(result, null, 2))
    })
    .catch((err) => {
      console.error('Erro ao registrar evidencia:', err)
      process.exit(1)
    })
}
