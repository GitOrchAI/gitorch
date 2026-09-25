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
