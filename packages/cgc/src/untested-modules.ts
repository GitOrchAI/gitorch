import { isTestLike } from './summarize-workspace.js'

/**
 * Heurística estrutural (zero-LLM): um módulo-fonte "tem teste" se existir
 * arquivo de teste no repo mapeável para o mesmo caminho relativo (sem extensões
 * de teste ou diretórios de teste como `__tests__`).
 */
function getSourcePath(relPath: string): string {
  return relPath
    .replace(/\.(test|spec)\.[a-z]+$/, '') // remove sufixos de teste
    .replace(/\.[a-z]+$/, '') // remove extensão base
    .replace(/(^|\/)(__tests__|tests?)\//g, '$1') // remove pastas de teste
}

export function computeUntestedModules(files: Array<{ relPath: string }>): string[] {
  const testedPaths = new Set(
    files.filter((f) => isTestLike(f.relPath)).map((f) => getSourcePath(f.relPath))
  )
  return files
    .filter((f) => !isTestLike(f.relPath))
    .map((f) => f.relPath)
    .filter((relPath) => !testedPaths.has(getSourcePath(relPath)))
}
