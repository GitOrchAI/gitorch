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
  /** Só em `tipo='alerta'` do Dependabot (Fase 1.2/5.2). */
  alerta?: DadosDoAlertaNaFicha | null
}

/** O que a ficha guarda de um alerta de dependência e o que foi decidido. */
export interface DadosDoAlertaNaFicha {
  fonte: 'dependabot'
  pacote: string
  ecossistema: string
  ghsa: string | null
  gravidade: 'critical' | 'high' | 'medium' | 'low'
  /** runtime = biblioteca do produto publicado; development = só ferramenta. */
  escopo: 'runtime' | 'development' | 'desconhecido'
  versaoCorrigida: string | null
  temCorrecao: boolean
  manifesto: string
  url: string
  destino: 'sprint-atual' | 'backlog' | 'sem-tarefa'
  motivo: string
}

export interface EntendimentoDoItem {
  deOndeVeio: string
  oQueMuda: string
  queAjusteE: string
  porQueExiste: string
}

/** Resultado da conferência de uma tarefa sem pedido (guardado em coluna
 *  própria, nunca dentro de `estado`). */
export type ConferenciaDoItem = Record<string, unknown>

export interface RepoItemRecord {
  id: string
  projectId: string
  tipo: TipoDoItem
  numero: number
  estado: EstadoDoItem
  origem: string | null
  issueNumber: number | null
  entendimento: EntendimentoDoItem | null
  /** Como o vínculo com o pedido foi achado. Nulo até alguém conferir. */
  vinculoOrigem?: string | null
  /** Resultado da conferência da tarefa. Nulo até alguém conferir. */
  conferencia?: ConferenciaDoItem | null
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
 *
 * Duas regras separam o que é retrato do que é vínculo:
 *  - `estado` é o retrato de agora e é TROCADO por inteiro quando vem.
 *    Nada derivado mora nele (por isso o vínculo tem coluna própria).
 *  - `origem`, `issueNumber`, `entendimento`, `vinculoOrigem` e `conferencia`
 *    só PREENCHEM: valor ausente, `undefined` ou `null` nunca apaga o que já
 *    está gravado (o webhook e a varredura chegam sem a issue de origem
 *    muitas vezes, e isso não pode desfazer um vínculo já achado). Um valor
 *    preenchido novo continua valendo, porque a origem pode ser reclassificada.
 */
export async function atualizarFichaDoItem(deps: {
  prisma: PrismaDaFichaDoItem
  projectId: string
  tipo: TipoDoItem
  numero: number
  /** Omitido = não mexe no retrato já gravado. Numa ficha nova, nasce com
   *  `{ status: 'desconhecido' }` até a próxima varredura ou webhook. */
  estado?: EstadoDoItem
  origem?: string | null
  /** Issue #877 item 3: a issue de origem (ex. PR 583 → issue 580, achada
   *  por `classificarOrigem`). Omitido ou `null` = não mexe no que já estava
   *  gravado. */
  issueNumber?: number | null
  /** Fase 2.4: o formulário de entendimento, quando já existe. Omitido ou
   *  `null` = nunca apaga um entendimento anterior por engano. */
  entendimento?: EntendimentoDoItem | null
  /** Como o vínculo com o pedido foi achado (só preenche). */
  vinculoOrigem?: string | null
  /** Resultado da conferência da tarefa (só preenche). */
  conferencia?: ConferenciaDoItem | null
}): Promise<RepoItemRecord> {
  const where = {
    projectId_tipo_numero: { projectId: deps.projectId, tipo: deps.tipo, numero: deps.numero },
  }
  const update: Record<string, unknown> = {}
  if (deps.estado !== undefined) update['estado'] = deps.estado
  if (deps.origem != null) update['origem'] = deps.origem
  if (deps.issueNumber != null) update['issueNumber'] = deps.issueNumber
  if (deps.entendimento != null) update['entendimento'] = deps.entendimento
  if (deps.vinculoOrigem != null) update['vinculoOrigem'] = deps.vinculoOrigem
  if (deps.conferencia != null) update['conferencia'] = deps.conferencia

  const linha = await deps.prisma.repoItem.upsert({
    where,
    create: {
      projectId: deps.projectId,
      tipo: deps.tipo,
      numero: deps.numero,
      estado: deps.estado ?? { status: 'desconhecido' },
      origem: deps.origem ?? null,
      issueNumber: deps.issueNumber ?? null,
      entendimento: deps.entendimento ?? null,
      vinculoOrigem: deps.vinculoOrigem ?? null,
      conferencia: deps.conferencia ?? null,
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
