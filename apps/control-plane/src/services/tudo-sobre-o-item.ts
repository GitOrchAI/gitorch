import type { PrismaClient } from '@prisma/client'

import { lerFichaDoItem, type TipoDoItem, type RepoItemRecord } from './ficha-do-item.js'

export interface RepoItemVinculosRecord {
  id: string
  repoItemId: string
  hierarquia: unknown
  milestone: unknown
  projectFields: unknown
  labelsAndAssignees: unknown
  prsLigados: unknown
  sessoesJules: unknown
  qaReview: unknown
  statusCheckRollup: unknown
}

export interface TudoSobreOItemDeps {
  prisma: Pick<PrismaClient, 'repoItem' | 'repoItemVinculos'>
  projectId: string
  tipo: TipoDoItem
  numero: number
}

export interface TudoSobreOItemResponse {
  item: RepoItemRecord
  vinculos: RepoItemVinculosRecord | null
}

export async function tudoSobreOItem(
  deps: TudoSobreOItemDeps
): Promise<TudoSobreOItemResponse | null> {
  const item = await lerFichaDoItem({
    prisma: deps.prisma as never,
    projectId: deps.projectId,
    tipo: deps.tipo,
    numero: deps.numero,
  })

  if (!item) return null

  const vinculos = await deps.prisma.repoItemVinculos.findUnique({
    where: { repoItemId: item.id },
  })

  return {
    item,
    vinculos: vinculos as RepoItemVinculosRecord | null,
  }
}

export function montarContextoDoItem(
  item: RepoItemRecord,
  vinculos: RepoItemVinculosRecord | null
): string {
  const parts: string[] = [`Item: ${item.tipo} #${item.numero}`]

  if (item.estado) {
    parts.push(`Estado: ${JSON.stringify(item.estado)}`)
  }

  if (vinculos) {
    if (vinculos.hierarquia) {
      parts.push(`Hierarquia: ${JSON.stringify(vinculos.hierarquia)}`)
    }
    if (vinculos.milestone) {
      parts.push(`Milestone: ${JSON.stringify(vinculos.milestone)}`)
    }
    if (vinculos.projectFields) {
      parts.push(`Campos do Projeto: ${JSON.stringify(vinculos.projectFields)}`)
    }
    if (vinculos.sessoesJules) {
      parts.push(`Sessões do Jules: ${JSON.stringify(vinculos.sessoesJules)}`)
    }
    if (vinculos.qaReview) {
      parts.push(`Último Parecer do QA (GitOrch): ${JSON.stringify(vinculos.qaReview)}`)
    }
    if (vinculos.statusCheckRollup) {
      parts.push(`Status CI (Rollup): ${JSON.stringify(vinculos.statusCheckRollup)}`)
    }
  } else {
    parts.push('Nenhum vínculo extra encontrado (grafo vazio).')
  }

  return parts.join('\n')
}
