import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { F6AgentRole, MissionContextEnricher } from '@gitorch/agents'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Resumo do codegraph em PROCESSO FILHO. O tree-sitter WASM pode morrer com
 * erro incapturável (memory access out of bounds em finalizador — visto em
 * produção): in-process, isso derruba o control plane inteiro; aqui, derruba
 * só o filho e a missão segue sem codegraph. Timeout cobre repo patológico.
 *
 * Um arquivo "venenoso" corrompe a instância WASM inteira (repo bagunçado é o
 * ALVO do produto — isso acontece): o filho denuncia o culpado (exit 3 +
 * marker) e o pai re-tenta num processo limpo excluindo-o, até MAX_POISONED.
 */
const MAX_POISONED_FILES = 5

export async function summarizeWorkspaceIsolated(
  workspacePath: string,
  timeoutMs = 90_000
): Promise<string | undefined> {
  const child = path.join(__dirname, 'codegraph-child.js')
  const poisoned: string[] = []

  for (let attempt = 0; attempt <= MAX_POISONED_FILES; attempt++) {
    let stdout: string
    try {
      const result = await execFileAsync(
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
    if (stdout.trim().length === 0) return undefined
    // Honestidade com quem decide: o resumo declara o que NÃO foi lido.
    return poisoned.length > 0
      ? `${stdout}\n(unparsable files, excluded from the graph: ${poisoned.join(', ')})`
      : stdout
  }
  return undefined
}

/**
 * Enriquecedor de contexto de missão do GitOrch. Roda no HOST (control plane),
 * depois do workspace clonado, e devolve linhas de CONHECIMENTO que o orquestrador
 * injeta no prompt do agente:
 *   - Codegraph: resumo estrutural indexado do código REAL (o RA "lê de verdade").
 *   - Memórias do projeto (Cortex): o que missões anteriores já entregaram —
 *     é o que faz os agentes APRENDEREM entre missões (o brief do RA chega ao PO,
 *     etc.). Isolado por projeto (wingId = projectId).
 * Cada etapa é best-effort e isolada: uma falhar não impede as outras nem a missão.
 */

/** Subconjunto do CortexClient que precisamos — estrutural, para testabilidade. */
export interface MissionMemory {
  recallLocal(wingId: string, roomId?: string, hallId?: string): Array<{ content: string }>
  writeDrawer(drawer: {
    id: string
    wingId: string
    roomId: string
    hallId: string
    content: string
    importance: number
    emotionalWeight: number
    createdAt: string
    validFrom: string
    confidence: number
    tags: string[]
  }): Promise<void>
}

const MAX_MEMORIES = 5
const MAX_MEMORY_CHARS = 800

export function buildMissionEnricher(
  deps: {
    cortex?: MissionMemory
    /** Injetável para teste; default = processo filho isolado. */
    summarize?: (workspacePath: string) => Promise<string | undefined>
  } = {}
): MissionContextEnricher {
  const summarize = deps.summarize ?? summarizeWorkspaceIsolated
  return async ({ workspacePath, projectId }) => {
    const lines: string[] = []

    if (workspacePath) {
      const codegraph = await summarize(workspacePath)
      if (codegraph) lines.push(codegraph)
    }

    if (deps.cortex) {
      try {
        const drawers = deps.cortex.recallLocal(projectId).slice(0, MAX_MEMORIES)
        if (drawers.length > 0) {
          const memoryBlock = [
            'Project memory (deliverables from prior GitOrch missions on THIS project — build on them, do not repeat work):',
            ...drawers.map(
              (d) => `- ${d.content.slice(0, MAX_MEMORY_CHARS).replace(/\s+/g, ' ').trim()}`
            ),
          ].join('\n')
          lines.push(memoryBlock)
        }
      } catch {
        /* memória é best-effort */
      }
    }

    return lines
  }
}

/**
 * Persiste o entregável de uma missão como memória tipada do projeto (drawer do
 * Cortex). Chamado pelo scheduler depois de uma missão bem-sucedida: assim o
 * conhecimento produzido por um agente fica disponível para os próximos.
 * Best-effort: falha aqui nunca derruba a missão (que já terminou).
 */
export async function persistMissionMemory(
  cortex: MissionMemory,
  args: { projectId: string; role: F6AgentRole; content: string; now: string }
): Promise<void> {
  const content = args.content.trim()
  if (content.length === 0) return

  try {
    await cortex.writeDrawer({
      id: randomUUID(),
      wingId: args.projectId,
      roomId: args.role,
      hallId: 'deliverable',
      content,
      importance: 0.7,
      emotionalWeight: 0,
      createdAt: args.now,
      validFrom: args.now,
      confidence: 0.8,
      tags: [args.role, 'deliverable'],
    })
  } catch {
    /* persistência de memória é best-effort */
  }
}
