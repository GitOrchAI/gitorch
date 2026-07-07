import { isTestLike } from './summarize-workspace.js'

/**
 * Heurística estrutural (zero-LLM): um módulo-fonte "tem teste" se existir
 * QUALQUER arquivo de teste no repo cujo nome-base bate com o dele — não
 * importa a pasta (cobre tanto `foo.test.ts` ao lado quanto `__tests__/foo.test.ts`).
 */
function testSubjectName(relPath: string): string | null {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1)
  const m = /^(.+?)\.(test|spec)\.[a-z]+$/.exec(base)
  return m?.[1] ?? null
}

function sourceBaseName(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1)
  return base.replace(/\.[a-z]+$/, '')
}

export function computeUntestedModules(files: Array<{ relPath: string }>): string[] {
  const testedSubjects = new Set(
    files.map((f) => testSubjectName(f.relPath)).filter((s): s is string => s !== null)
  )
  return files
    .filter((f) => !isTestLike(f.relPath))
    .map((f) => f.relPath)
    .filter((relPath) => !testedSubjects.has(sourceBaseName(relPath)))
}
