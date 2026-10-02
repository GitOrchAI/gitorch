import { PrismaClient } from '@prisma/client'

export interface RecordEvidenceOptions {
  apiUrl?: string
  projectId?: string
  commitHash?: string
  branch?: string
  status?: string
  evidenceSummary?: Record<string, unknown>
  eventSource?: string
  runId?: string
}

export async function recordPipelineEvidence(options: RecordEvidenceOptions = {}) {
  const apiUrl = options.apiUrl || process.env.GITORCH_API_URL || 'http://127.0.0.1:4012'
  const projectId = options.projectId || process.env.PROJECT_ID || 'proj_ci_staging'
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

  // Se DATABASE_URL estiver configurada, garante que o projeto exista para a rota /analyze
  if (process.env.DATABASE_URL) {
    const prisma = new PrismaClient()
    try {
      const existing = await prisma.project.findUnique({ where: { id: projectId } })
      if (!existing) {
        await prisma.project.create({
          data: {
            id: projectId,
            wingId: 'GitOrchAI/gitorch',
            name: 'GitOrch CI Staging',
          },
        })
      }
    } catch (dbErr) {
      console.warn('[recordPipelineEvidence] Aviso ao checar banco direto:', dbErr)
    } finally {
      await prisma.$disconnect()
    }
  }

  // Aciona primeiro /analyze para inicializar ou atualizar o PipelineConfig
  const analyzeEndpoint = `${apiUrl}/api/v1/projects/${projectId}/pipelines/analyze`
  const analyzeRes = await fetch(analyzeEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })

  if (!analyzeRes.ok) {
    const errText = await analyzeRes.text()
    console.warn(`[recordPipelineEvidence] /analyze retornou HTTP ${analyzeRes.status}: ${errText}`)
  }

  // Aciona o endpoint de registro de evidência
  const endpoint = `${apiUrl}/api/v1/projects/${projectId}/pipelines/evidence`
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
    headers: {
      'Content-Type': 'application/json',
    },
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
