import { randomUUID } from 'node:crypto'
import { summarizeWorkspace } from '@gitorch/cgc'
import type { F6AgentRole, MissionContextEnricher } from '@gitorch/agents'

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

export function buildMissionEnricher(deps: { cortex?: MissionMemory } = {}): MissionContextEnricher {
  return async ({ workspacePath, projectId }) => {
    const lines: string[] = []

    if (workspacePath) {
      try {
        const codegraph = await summarizeWorkspace(workspacePath)
        if (codegraph) lines.push(codegraph)
      } catch {
        /* codegraph é best-effort */
      }
    }

    if (deps.cortex) {
      try {
        const drawers = deps.cortex.recallLocal(projectId).slice(0, MAX_MEMORIES)
        if (drawers.length > 0) {
          const memoryBlock = [
            'Project memory (deliverables from prior GitOrch missions on THIS project — build on them, do not repeat work):',
            ...drawers.map((d) => `- ${d.content.slice(0, MAX_MEMORY_CHARS).replace(/\s+/g, ' ').trim()}`),
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
