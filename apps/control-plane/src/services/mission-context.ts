import { summarizeWorkspace } from '@gitorch/cgc'
import type { MissionContextEnricher } from '@gitorch/agents'

/**
 * Enriquecedor de contexto de missão do GitOrch. Roda no HOST (control plane),
 * depois do workspace clonado, e devolve linhas de CONHECIMENTO que o orquestrador
 * injeta no prompt do agente:
 *   - Codegraph: resumo estrutural indexado do código REAL (o RA "lê de verdade").
 *   - (T9) Memórias do projeto do Cortex, tipadas por papel.
 * Cada etapa é best-effort e isolada: uma falhar não impede as outras nem a missão.
 */
export function buildMissionEnricher(): MissionContextEnricher {
  return async ({ workspacePath }) => {
    const lines: string[] = []

    if (workspacePath) {
      try {
        const codegraph = await summarizeWorkspace(workspacePath)
        if (codegraph) lines.push(codegraph)
      } catch {
        /* codegraph é best-effort */
      }
    }

    return lines
  }
}
