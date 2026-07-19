import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GraphExportResult } from '@gitorch/cgc'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

type ExecFileImpl = (
  cmd: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number }
) => Promise<{ stdout: string; stderr: string }>

const MAX_POISONED_FILES = 5

/**
 * Mesmo protocolo de isolamento de diagnoseWorkspaceIsolated
 * (workspace-diagnosis.ts) — processo FILHO porque o parser WASM pode morrer
 * com erro incapturável — mas devolve o grafo bruto (nós+arestas) pro
 * `RepoGraph3D` desenhar, não o diagnóstico agregado. `maxBuffer` maior que o
 * diagnóstico: o grafo pode ter até 1500 nós + arestas, um payload bem mais
 * largo que o JSON de métricas.
 */
export async function exportGraphIsolated(
  workspacePath: string,
  maxNodes = 1500,
  timeoutMs = 90_000,
  execFileImpl: ExecFileImpl = execFileAsync
): Promise<GraphExportResult | undefined> {
  const child = path.join(__dirname, 'graph-export-child.js')
  const poisoned: string[] = []

  for (let attempt = 0; attempt <= MAX_POISONED_FILES; attempt++) {
    let stdout: string
    try {
      const result = await execFileImpl(
        process.execPath,
        [child, workspacePath, JSON.stringify(poisoned), String(maxNodes)],
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }
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
      return JSON.parse(trimmed) as GraphExportResult
    } catch {
      return undefined
    }
  }
  return undefined
}
