import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StructuralDiagnosis } from '@gitorch/cgc'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

type ExecFileImpl = (
  cmd: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number }
) => Promise<{ stdout: string; stderr: string }>

const MAX_POISONED_FILES = 5

/**
 * Mesmo protocolo de isolamento de summarizeWorkspaceIsolated (mission-context.ts)
 * — processo FILHO porque o parser WASM pode morrer com erro incapturável — mas
 * devolve o diagnóstico ESTRUTURADO (JSON) pra UI do wizard, não markdown pra LLM.
 */
export async function diagnoseWorkspaceIsolated(
  workspacePath: string,
  timeoutMs = 90_000,
  execFileImpl: ExecFileImpl = execFileAsync
): Promise<StructuralDiagnosis | undefined> {
  const child = path.join(__dirname, 'diagnose-child.js')
  const poisoned: string[] = []

  for (let attempt = 0; attempt <= MAX_POISONED_FILES; attempt++) {
    let stdout: string
    try {
      const result = await execFileImpl(
        process.execPath,
        [child, workspacePath, JSON.stringify(poisoned)],
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }
      )
      stdout = result.stdout
    } catch (err) {
      // exit 3 = veneno identificado; execFile entrega o stdout no erro.
      const e = err as { code?: number; stdout?: string }
      const marker = (e.stdout ?? '').match(/^POISON:(.+)$/)
      if (e.code === 3 && marker?.[1] && !poisoned.includes(marker[1])) {
        poisoned.push(marker[1])
        continue
      }
      return undefined
    }
    const trimmed = stdout.trim()
    if (trimmed.length === 0 || trimmed === 'null') return undefined
    try {
      return JSON.parse(trimmed) as StructuralDiagnosis
    } catch {
      return undefined
    }
  }
  return undefined
}
