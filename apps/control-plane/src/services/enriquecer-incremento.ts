// Os quatro campos do Incremento que a régua ainda não grava: sprint, "o que
// era" (título), "quanto pesava" e "pedido seu ou proativo".
//
// NADA DE RASTREIO NOVO — os quatro já existem no GitHub, gravados por
// caminhos que já rodam hoje:
//   - sprint     : o milestone nativo da issue ("Sprint N"), que
//                  backlog-executor.ts já grava via setMilestone.
//   - titulo     : o título da issue.
//   - peso       : lido por `pesoDoCorpoDaIssue` (backlog-executor.ts), o
//                  MESMO leitor que o backfill do quadro (D8/#435) usa — uma
//                  segunda regra de parsing aqui divergiria da primeira no
//                  dia em que o formato mudar.
//   - origem     : o marker `gitorch:node:<wish>:...` que ensureNode grava no
//                  corpo de TODO nó criado a partir de uma wish. Só a wish
//                  nasce com a etiqueta `wishlist` (routes/index.ts,
//                  plugins/telegram.ts — desejo.ts::ETIQUETA_DE_DESEJO); os
//                  dois caminhos proativos (aviso-de-publicação,
//                  conserto-de-publicação) criam a issue direto, sem passar
//                  pela árvore do PO, e por isso nunca ganham este marker.
//                  Task com marker → nasceu de uma wish → pedido do dono.
//                  Task sem marker → o produto criou por conta própria →
//                  proativo.
//
import { pesoDoCorpoDaIssue } from './backlog-executor.js'

// Best-effort de propósito: um GitHub instável não pode impedir o registro do
// Incremento (o fato "isto ficou pronto" é o que mais importa). Cada busca
// falha OLHANDO SÓ PRA SI — a falha de uma não apaga o que as outras já
// confirmaram.

/** A issue, do jeito que basta para enriquecer um Incremento. */
export interface IssueResumo {
  titulo: string
  /** `null` quando a issue não tem corpo — o GitHub aceita issue vazia. */
  corpo: string | null
  criadaEm: Date
  /** Título do milestone nativo ("Sprint 3"), ou nulo se a issue não tem um. */
  sprint: string | null
}

/** O pull request, do jeito que basta para saber quando mesclou. */
export interface PrResumo {
  mescladoEm: Date | null
}

export type Origem = 'pedido' | 'proativo'

export interface CamposDoIncremento {
  sprint: string | null
  titulo: string | null
  peso: number | null
  pedidoOuProativo: Origem
  wishCreatedAt: Date | null
  mergedAt: Date | null
}

export interface DepsDoEnriquecimento {
  /** Busca uma issue pelo número. `null` = não encontrada (404). */
  buscarIssue: (numero: number) => Promise<IssueResumo | null>
  /** Ausente = sem como consultar PR (mergedAt fica nulo, nunca inventado). */
  buscarPR?: ((numero: number) => Promise<PrResumo | null>) | undefined
}

/** O que registrar quando nada pôde ser confirmado. Nunca inventar um meio-termo. */
export const CAMPOS_VAZIOS: CamposDoIncremento = {
  sprint: null,
  titulo: null,
  peso: null,
  pedidoOuProativo: 'proativo',
  wishCreatedAt: null,
  mergedAt: null,
}

// O MESMO formato que `renderIssueBody`/`ensureNode` (backlog-executor.ts)
// gravam: `<!-- gitorch:node:<wish>:<tipo>:<indice> -->`, tipo em
// phase|epic|feature|task. A mesma família de regex que
// github-backlog.ts:132 já usa para reconhecer o marker.
const MARCA_DE_NO = /<!--\s*gitorch:node:(\d+):(?:phase|epic|feature|task):\d+\s*-->/

/** O número da wish que originou este nó, pelo marker gravado no corpo. */
export function extrairWishNumber(corpo: string | null): number | null {
  if (!corpo) return null
  const m = corpo.match(MARCA_DE_NO)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/**
 * Pedido do dono (nasceu de uma wish) ou melhoria proativa do produto.
 *
 * Sem o marker não dá para PROVAR que veio de um pedido — o padrão seguro é
 * tratar como proativo, nunca supor pedido sem prova.
 */
export function origemDoIncremento(corpo: string | null): Origem {
  return extrairWishNumber(corpo) !== null ? 'pedido' : 'proativo'
}

/**
 * O peso (1,2,3,5,8,13) já escrito no corpo pelo PO, relido — nunca
 * recalculado. Delega para `pesoDoCorpoDaIssue` (backlog-executor.ts), a
 * MESMA leitura por seção que o backfill do quadro (D8/#435) usa.
 */
export function extrairPeso(corpo: string | null): number | null {
  return pesoDoCorpoDaIssue(corpo)
}

/**
 * Monta os seis campos do Incremento que a régua ainda não grava, a partir
 * de fatos que o GitHub já tem.
 *
 * Cada busca é isolada: a falha de uma (rede, 404, timeout) não apaga o que
 * as outras já confirmaram — devolve nulo SÓ no campo afetado. Só quando a
 * issue base (a própria task) não pôde ser lida é que devolve os seis campos
 * vazios: sem ela não há título, nem corpo para achar peso/origem, nem data
 * de criação — nada sobra para aproveitar.
 */
export async function buscarCamposDoIncremento(
  deps: DepsDoEnriquecimento,
  args: { issueNumber: number; pullRequestNumber: number | null }
): Promise<CamposDoIncremento> {
  let issue: IssueResumo | null
  try {
    issue = await deps.buscarIssue(args.issueNumber)
  } catch {
    return { ...CAMPOS_VAZIOS }
  }
  if (!issue) return { ...CAMPOS_VAZIOS }

  const peso = extrairPeso(issue.corpo)
  const wishNumber = extrairWishNumber(issue.corpo)
  const pedidoOuProativo: Origem = wishNumber !== null ? 'pedido' : 'proativo'

  // Proativo: a própria issue É a origem — não há wish para consultar.
  // Pedido: o INÍCIO do ciclo é quando a WISH nasceu, não quando esta task
  // (um dos vários nós debaixo dela) foi criada depois pelo PO.
  let wishCreatedAt: Date | null = issue.criadaEm
  if (wishNumber !== null) {
    try {
      const wish = await deps.buscarIssue(wishNumber)
      wishCreatedAt = wish?.criadaEm ?? null
    } catch {
      // Não confirmou a wish: fica nulo. Usar a data da TASK aqui seria
      // confundir "não sei quando o desejo nasceu" com "sei, e foi agora".
      wishCreatedAt = null
    }
  }

  let mergedAt: Date | null = null
  if (args.pullRequestNumber !== null && deps.buscarPR) {
    try {
      const pr = await deps.buscarPR(args.pullRequestNumber)
      mergedAt = pr?.mescladoEm ?? null
    } catch {
      mergedAt = null
    }
  }

  return {
    sprint: issue.sprint,
    titulo: issue.titulo,
    peso,
    pedidoOuProativo,
    wishCreatedAt,
    mergedAt,
  }
}
