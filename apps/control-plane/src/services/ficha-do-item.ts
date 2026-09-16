// A ficha do item do repositório: estado ATUAL de um pedido, tarefa ou
// alerta, por (projeto, tipo, número). O histórico continua em `events`
// (registrarNoPainelUmaVez, registro-no-painel.ts) — esta tabela nunca
// guarda uma lista de acontecimentos, só o retrato de agora.

export type TipoDoItem = 'pr' | 'issue' | 'alerta'

export interface EstadoDoItem {
  status: string
  verificacao?: string | null
  revisoes?: string | null
  conflito?: boolean | null
  rascunho?: boolean | null
  ultimoCommitEm?: string | null
  arquivosMexidos?: string[] | null
}

export interface EntendimentoDoItem {
  deOndeVeio: string
  oQueMuda: string
  queAjusteE: string
  porQueExiste: string
}

export interface RepoItemRecord {
  id: string
  projectId: string
  tipo: TipoDoItem
  numero: number
  estado: EstadoDoItem
  origem: string | null
  issueNumber: number | null
  entendimento: EntendimentoDoItem | null
}

/** Só o que `ficha-do-item.ts` precisa do Prisma. */
export interface PrismaDaFichaDoItem {
  repoItem: {
    upsert: (args: {
      where: { projectId_tipo_numero: { projectId: string; tipo: TipoDoItem; numero: number } }
      create: Record<string, unknown>
      update: Record<string, unknown>
    }) => Promise<unknown>
    findUnique: (args: {
      where: { projectId_tipo_numero: { projectId: string; tipo: TipoDoItem; numero: number } }
    }) => Promise<RepoItemRecord | null>
  }
}

/**
 * Grava/atualiza a ficha de um item. Chamado pelos handlers de webhook
 * (Fase 0.3) e pela varredura de 30 min (Fase 1.3) — as DUAS fontes que
 * alimentam o estado atual.
 */
export async function atualizarFichaDoItem(deps: {
  prisma: PrismaDaFichaDoItem
  projectId: string
  tipo: TipoDoItem
  numero: number
  estado: EstadoDoItem
  origem?: string | null
  /** Fase 2.4: o formulário de entendimento, quando já existe. Omitido =
   *  não mexe no que já estava gravado (mesmo upsert PARCIAL de `origem`
   *  acima) — nunca apaga um entendimento anterior por engano. */
  entendimento?: EntendimentoDoItem | null
}): Promise<RepoItemRecord> {
  const where = {
    projectId_tipo_numero: { projectId: deps.projectId, tipo: deps.tipo, numero: deps.numero },
  }
  const update: Record<string, unknown> = { estado: deps.estado }
  if (deps.origem !== undefined) update['origem'] = deps.origem
  if (deps.entendimento !== undefined) update['entendimento'] = deps.entendimento

  const linha = await deps.prisma.repoItem.upsert({
    where,
    create: {
      projectId: deps.projectId,
      tipo: deps.tipo,
      numero: deps.numero,
      estado: deps.estado,
      origem: deps.origem ?? null,
      entendimento: deps.entendimento ?? null,
    },
    update,
  })
  return linha as RepoItemRecord
}

/** Lê a ficha, ou `null` quando ainda não existe (item nunca visto). */
export async function lerFichaDoItem(deps: {
  prisma: PrismaDaFichaDoItem
  projectId: string
  tipo: TipoDoItem
  numero: number
}): Promise<RepoItemRecord | null> {
  return deps.prisma.repoItem.findUnique({
    where: {
      projectId_tipo_numero: { projectId: deps.projectId, tipo: deps.tipo, numero: deps.numero },
    },
  })
}
