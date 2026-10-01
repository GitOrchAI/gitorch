// Issue #877: a consulta ÚNICA que junta a ficha (`ficha-do-item.ts`, estado
// atual) com o grafo completo de vínculos (`grafo-de-vinculos.ts`, coletado
// via GraphQL em `atualizarGrafoDeVinculos`) para UM item (issue ou PR), por
// (projectId, numero) — sem o chamador ter que saber o `tipo` de antemão.
//
// Por que sem `tipo` no argumento: o GitHub numera issues e PRs na MESMA
// sequência por repositório — nunca existe issue #580 E PR #580 no mesmo
// repo. Buscar sem tipo é seguro; só alertas de segurança (`tipo: 'alerta'`)
// têm numeração própria e ficam de fora desta consulta.
//
// `montarContextoDoItem` empacota o mesmo resultado em texto humano PT-BR,
// best-effort, para injetar em prompt de decisão (QA, vigia) — nunca lança:
// uma fonte de dado corrompida ou uma linha ausente vira `null`/linha omitida,
// nunca um erro que derruba quem chama.

import type { PrismaClient, Prisma } from '@prisma/client'
import type { EstadoDoItem, EntendimentoDoItem, TipoDoItem } from './ficha-do-item.js'
import type { GrafoCompletoDoItem } from '@gitorch/github-sync'
import type { SessaoDoGrafoJson } from './grafo-de-vinculos.js'
import { MARCA_DO_PARECER } from './parecer-do-qa.js'

/** O grafo de vínculos de um item, na forma que `tudoSobreOItem` devolve —
 *  mesmos campos de `GrafoCompletoDoItem` (`@gitorch/github-sync`) mais
 *  `sessoesJules` (`SessaoDoGrafoJson[]`, `grafo-de-vinculos.ts`), que não
 *  vem do GraphQL e sim de `dev_sessions`. */
export interface VinculosDoItem {
  hierarquia: GrafoCompletoDoItem['hierarquia'] | null
  milestone: GrafoCompletoDoItem['milestone']
  projectFields: GrafoCompletoDoItem['projectFields'] | null
  labelsAndAssignees: GrafoCompletoDoItem['labelsAndAssignees'] | null
  prsLigados: GrafoCompletoDoItem['prsLigados'] | null
  sessoesJules: SessaoDoGrafoJson[] | null
  qaReview: GrafoCompletoDoItem['qaReview']
  statusCheckRollup: GrafoCompletoDoItem['statusCheckRollup']
}

/** A ficha (`RepoItemRecord`, `ficha-do-item.ts`) mais o grafo de vínculos —
 *  `vinculos: null` quando a linha existe mas o grafo ainda não foi coletado
 *  (nunca inventa um objeto vazio no lugar). */
export interface FichaComVinculos {
  id: string
  projectId: string
  tipo: TipoDoItem
  numero: number
  estado: EstadoDoItem
  origem: string | null
  issueNumber: number | null
  entendimento: EntendimentoDoItem | null
  vinculos: VinculosDoItem | null
}

/**
 * Colunas `Json?`/`Json` chegam do Prisma real como `Prisma.JsonValue`
 * (`string | number | boolean | JsonObject | JsonArray | null`) — sem
 * validação de shape pelo banco. `null`/`undefined` viram `null` no runtime
 * check ABAIXO do cast (nunca confia cegamente no shape); um valor presente
 * é convertido com um cast LOCAL, porque a forma real é imposta por quem
 * grava (`atualizarFichaDoItem`/`atualizarGrafoDeVinculos`) a partir do
 * GitHub — nunca inventada aqui.
 */
function comoObjeto<T>(valor: Prisma.JsonValue | null | undefined): T | null {
  if (valor === null || valor === undefined) return null
  return valor as unknown as T
}

/**
 * Busca UMA linha em `repo_items` por `(projectId, numero)`, com o grafo de
 * vínculos (`vinculos`, relação 1:1) incluído. `null` quando não há ficha
 * (item nunca visto).
 */
export async function tudoSobreOItem(deps: {
  prisma: Pick<PrismaClient, 'repoItem'>
  projectId: string
  numero: number
}): Promise<FichaComVinculos | null> {
  const linha = await deps.prisma.repoItem.findFirst({
    where: { projectId: deps.projectId, numero: deps.numero, tipo: { in: ['issue', 'pr'] } },
    include: { vinculos: true },
  })
  if (!linha) return null

  return {
    id: linha.id,
    projectId: linha.projectId,
    // `tipo` é `String` no schema (sem enum do Postgres) — o `where` acima já
    // restringe a 'issue'/'pr', então o cast só nomeia o que a query garante.
    tipo: linha.tipo as TipoDoItem,
    numero: linha.numero,
    estado: comoObjeto<EstadoDoItem>(linha.estado) ?? ({ status: 'unknown' } as EstadoDoItem),
    origem: linha.origem,
    issueNumber: linha.issueNumber,
    entendimento: comoObjeto<EntendimentoDoItem>(linha.entendimento),
    vinculos: linha.vinculos
      ? {
          hierarquia: comoObjeto<VinculosDoItem['hierarquia']>(linha.vinculos.hierarquia),
          milestone: comoObjeto<VinculosDoItem['milestone']>(linha.vinculos.milestone),
          projectFields: comoObjeto<VinculosDoItem['projectFields']>(linha.vinculos.projectFields),
          labelsAndAssignees: comoObjeto<VinculosDoItem['labelsAndAssignees']>(
            linha.vinculos.labelsAndAssignees
          ),
          prsLigados: comoObjeto<VinculosDoItem['prsLigados']>(linha.vinculos.prsLigados),
          sessoesJules: comoObjeto<SessaoDoGrafoJson[]>(linha.vinculos.sessoesJules),
          qaReview: comoObjeto<VinculosDoItem['qaReview']>(linha.vinculos.qaReview),
          statusCheckRollup: comoObjeto<VinculosDoItem['statusCheckRollup']>(
            linha.vinculos.statusCheckRollup
          ),
        }
      : null,
  }
}

/** 'OPEN' | 'CLOSED' | 'MERGED' (GitHub GraphQL) → palavra PT-BR; estado
 *  desconhecido cai no próprio texto em minúsculas, nunca inventa rótulo. */
function estadoPt(state: string): string {
  const mapa: Record<string, string> = { OPEN: 'aberta', CLOSED: 'fechada', MERGED: 'mesclada' }
  return mapa[state.toUpperCase()] ?? state.toLowerCase()
}

/** Achata um "resumo" de review (pode ter várias linhas e até 2000
 *  caracteres — `getGrafoCompletoDoPr`, `project-v2-client.ts`) numa única
 *  linha de contexto, sem explodir o tamanho do bloco. Heurística: nunca
 *  revisada como formatação de produto. */
const LIMITE_DO_RESUMO_QA = 240
function umaLinha(texto: string): string {
  const achatado = texto.replace(/\s*\n+\s*/g, ' ').trim()
  return achatado.length > LIMITE_DO_RESUMO_QA
    ? `${achatado.slice(0, LIMITE_DO_RESUMO_QA)}…`
    : achatado
}

/** As linhas de fato objetivo do grafo — só o que existe de verdade; omite a
 *  linha quando o campo correspondente é `null`/vazio. Nunca inventa vínculo. */
function montarLinhas(vinculos: VinculosDoItem): string[] {
  const linhas: string[] = []

  const parents = vinculos.hierarquia?.parents ?? []
  if (parents.length > 0) {
    linhas.push(
      `Hierarquia: ${parents.map((p) => `#${p.number} (${estadoPt(p.state)})`).join(' → ')}`
    )
  }

  if (vinculos.milestone) {
    const prazo = vinculos.milestone.dueOn ? vinculos.milestone.dueOn.split('T')[0] : 'sem prazo'
    linhas.push(
      `Milestone: ${vinculos.milestone.title} (prazo ${prazo}, ${vinculos.milestone.state})`
    )
  }

  for (const pf of vinculos.projectFields ?? []) {
    const partes = [`status=${pf.status ?? '?'}`]
    if (pf.iteration) {
      partes.push(
        `sprint=${pf.iteration.title} (${pf.iteration.startDate}, ${pf.iteration.duration}d)`
      )
    }
    if (pf.peso !== null && pf.peso !== undefined) partes.push(`peso=${pf.peso}`)
    linhas.push(`Quadro ${pf.project.title}: ${partes.join(', ')}`)
  }

  const labels = vinculos.labelsAndAssignees?.labels ?? []
  if (labels.length > 0) linhas.push(`Labels: ${labels.join(', ')}`)

  const prsLigados = new Set<number>([
    ...(vinculos.prsLigados?.closedByPullRequests ?? []),
    ...(vinculos.prsLigados?.crossReferencedPullRequests ?? []),
  ])
  if (prsLigados.size > 0) {
    linhas.push(`PRs ligados: ${[...prsLigados].map((n) => `#${n}`).join(', ')}`)
  }

  const sessoes = vinculos.sessoesJules ?? []
  if (sessoes.length > 0) {
    const exemplo = sessoes[0]!
    linhas.push(
      `Sessões do Jules: ${sessoes.length} (ex.: ${exemplo.sessionName} state=${exemplo.state})`
    )
  }

  if (vinculos.qaReview) {
    const quando = vinculos.qaReview.submittedAt ?? 'data desconhecida'
    // A marca `<!-- gitorch:qa -->` (parecer-do-qa.ts) é sinal interno para o
    // próprio produto reconhecer o parecer no GitHub — não tem valor nenhum
    // num bloco de contexto para humano/LLM, então sai antes de achatar.
    const resumoLimpo = vinculos.qaReview.resumo.replace(MARCA_DO_PARECER, '').trim()
    linhas.push(
      `Último parecer do QA: ${vinculos.qaReview.state} em ${quando}: ${umaLinha(resumoLimpo)}`
    )
  }

  if (vinculos.statusCheckRollup) {
    linhas.push(`CI: ${vinculos.statusCheckRollup}`)
  }

  return linhas
}

/**
 * Formata o grafo de vínculos de um item em texto humano PT-BR, para injetar
 * como contexto num prompt de decisão. Best-effort: NUNCA lança — qualquer
 * erro interno vira `null`. `null` também quando não há ficha, ou a ficha
 * existe mas o grafo ainda não foi coletado (nada a acrescentar).
 */
export async function montarContextoDoItem(deps: {
  prisma: Pick<PrismaClient, 'repoItem'>
  projectId: string
  numero: number
}): Promise<{ linhas: string[]; bloco: string } | null> {
  try {
    const item = await tudoSobreOItem(deps)
    if (!item || !item.vinculos) return null

    const linhas = montarLinhas(item.vinculos)
    const bloco = [`Grafo de vínculos do item #${deps.numero}:`, ...linhas].join('\n')
    return { linhas, bloco }
  } catch {
    return null
  }
}
