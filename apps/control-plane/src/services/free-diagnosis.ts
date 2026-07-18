import { LocalWorkspaceProvider } from '@gitorch/workspace-engine'
import { diagnoseWorkspaceIsolated } from './workspace-diagnosis.js'
import { fetchGithubSignals, type GithubSignals } from './github-signals.js'
import { buildDiagnosisFindings } from './diagnosis-findings.js'
import { classifyDiagnosisError } from '../lib/setup-errors.js'
import type { StructuralDiagnosis } from '@gitorch/cgc'

interface WorkspaceProviderLike {
  allocateWorkspace(
    userId: string,
    slug: string,
    options: { repository: string; token: string }
  ): Promise<{ path: string }>
}

interface DiagnosisJobPrisma {
  diagnosisJob: {
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>
  }
}

export interface FreeDiagnosisDeps {
  prisma: DiagnosisJobPrisma
  workspaceProvider?: WorkspaceProviderLike
  diagnose?: (workspacePath: string) => Promise<StructuralDiagnosis | undefined>
  fetchSignals?: (repoFullName: string, token: string) => Promise<GithubSignals>
  // Clone já existente (do ambiente do cliente, passo 4) a reaproveitar em vez
  // de clonar de novo. Ausente = clona o próprio diag-<repo> (teaser puro).
  existingWorkspacePath?: string
}

export interface ProcessDiagnosisArgs {
  userId: string
  repoFullName: string
  githubToken: string
}

/**
 * Path determinístico por (usuário, repo) — nunca por jobId. A Fase 4 reusa
 * este MESMO clone quando o Project é criado de verdade (não clona 2x); o
 * prefixo `diag-` garante que nunca colide com um workspace de Project real
 * (que usa o projectId puro no mesmo baseDir).
 */
export function repoWorkspaceSlug(repoFullName: string): string {
  return `diag-${repoFullName.replace(/[^a-zA-Z0-9]/g, '_')}`
}

/**
 * Orquestra o diagnóstico grátis (F1): clona (isolado, com o token do
 * próprio usuário) → indexa o código (CGC, zero-LLM) → lê sinais do GitHub →
 * cruza tudo num veredito. Narra o progresso passo a passo no DiagnosisJob
 * pra tela consumir por polling. Nunca lança: toda falha vira status=failed
 * + error no job (honestidade real-primeiro — nunca um estado "travado").
 */
export async function processDiagnosisJob(
  jobId: string,
  args: ProcessDiagnosisArgs,
  deps: FreeDiagnosisDeps
): Promise<void> {
  const provider = deps.workspaceProvider ?? new LocalWorkspaceProvider()
  const diagnose = deps.diagnose ?? diagnoseWorkspaceIsolated
  const fetchSignals = deps.fetchSignals ?? fetchGithubSignals

  const setProgress = (progress: string): Promise<unknown> =>
    deps.prisma.diagnosisJob.update({
      where: { id: jobId },
      data: { status: 'running', progress },
    })

  try {
    await setProgress('cloning')
    // Reaproveita o clone do ambiente (passo 4) se já existe — não clona 2x.
    // Sem ambiente (teaser puro), clona o próprio diag-<repo> como antes.
    const ws = deps.existingWorkspacePath
      ? { path: deps.existingWorkspacePath }
      : await provider.allocateWorkspace(args.userId, repoWorkspaceSlug(args.repoFullName), {
          repository: args.repoFullName,
          token: args.githubToken,
        })

    await setProgress('indexing')
    const structural = await diagnose(ws.path)

    await setProgress('reading_github')
    const signals = await fetchSignals(args.repoFullName, args.githubToken)

    if (!structural) {
      // Repo sem código-fonte reconhecido (vazio/binário/etc.) — estado
      // HONESTO, não uma falha: o clone e a leitura do GitHub funcionaram.
      await deps.prisma.diagnosisJob.update({
        where: { id: jobId },
        data: {
          status: 'completed',
          progress: 'done',
          completedAt: new Date(),
          result: { empty: true, github: signals },
        },
      })
      return
    }

    const { healthScore, findings } = buildDiagnosisFindings(structural, signals)

    await deps.prisma.diagnosisJob.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        progress: 'done',
        completedAt: new Date(),
        result: { structural, github: signals, healthScore, findings },
      },
    })
  } catch (err) {
    // "CODE: mensagem" — o code é o CONTRATO estável que o front usa pra
    // escolher a dica traduzida certa (setupErrorHintKey); a mensagem crua
    // continua ali atrás, só pra log/depuração (GET /api/v1/diagnose/:id
    // repassa o job inteiro sem reformatar).
    const code = classifyDiagnosisError(err)
    const message = err instanceof Error ? err.message : String(err)
    await deps.prisma.diagnosisJob
      .update({
        where: { id: jobId },
        data: { status: 'failed', error: `${code}: ${message}`, completedAt: new Date() },
      })
      .catch(() => {
        /* melhor esforço: se nem o registro de falha grava, não há mais o que fazer aqui */
      })
  }
}
