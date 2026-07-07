import { analyzeWorkspace, type SummarizeOptions } from './summarize-workspace.js'
import { computeUntestedModules } from './untested-modules.js'

/**
 * Diagnóstico estrutural do repo, em JSON, para a UI (F1 — diagnóstico grátis
 * do setup wizard). Mesma indexação zero-LLM de summarizeWorkspace, formatada
 * pra tela em vez de contexto de LLM. Nunca lança por falta de código-fonte
 * (devolve null); PoisonedFileError ainda propaga (o chamador isolado decide).
 */
export interface StructuralDiagnosis {
  fileCount: number
  indexedFiles: number
  symbolsByType: Record<string, number>
  largestFiles: Array<{ file: string; symbolCount: number }>
  mostCalledFunctions: Array<{ name: string; file: string; callCount: number }>
  untestedModules: string[]
  directoryInventory: Record<string, string[]>
}

function buildDirectoryInventory(sources: Array<{ relPath: string }>): Record<string, string[]> {
  const byDir: Record<string, string[]> = {}
  for (const s of sources) {
    const slash = s.relPath.lastIndexOf('/')
    const dir = slash === -1 ? '.' : s.relPath.slice(0, slash)
    const base = s.relPath.slice(slash + 1)
    ;(byDir[dir] ??= []).push(base)
  }
  for (const dir of Object.keys(byDir)) byDir[dir]!.sort()
  return byDir
}

export async function diagnoseWorkspaceStructural(
  workspacePath: string,
  options: SummarizeOptions = {}
): Promise<StructuralDiagnosis | null> {
  const analysis = await analyzeWorkspace(workspacePath, options)
  if (!analysis) return null

  return {
    fileCount: analysis.fileCount,
    indexedFiles: analysis.sources.length,
    symbolsByType: Object.fromEntries(analysis.byType.map((t) => [t.type, t.count])),
    largestFiles: analysis.topFiles,
    mostCalledFunctions: analysis.mostCalled,
    untestedModules: computeUntestedModules(analysis.sources),
    directoryInventory: buildDirectoryInventory(analysis.sources),
  }
}
