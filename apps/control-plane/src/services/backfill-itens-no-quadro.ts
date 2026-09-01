// D12 — o produto CRIA a issue (backlog-executor.ts) e agora TAMBÉM a
// adiciona ao quadro no mesmo instante (github-backlog.ts, addToBoard). Mas
// isso só vale para issue nova: as que já existiam quando o board foi
// apontado certo (D11) ficam de fora para sempre, a não ser por uma passada
// de catch-up — o MESMO formato de `backfill-peso-existentes.ts` (D8), que
// resolveu o furo gêmeo do campo "Peso".
//
// MEDIDO em 01/09/2026 contra loureng/patinhas-3d-crafts: 96 issues abertas
// no repositório, ZERO no quadro (retrato de maio, #2705-#2961; o repo já
// vai de #3611 a #3884). NEM TODAS as 96 são do produto — 11 são "wishlist"
// (pedido do dono, ainda não virou plano) ou "security" (Dependabot) — e
// aplicar o backfill nelas inundaria o quadro do dono com itens que ele
// nunca pediu para o produto tratar. `issueECriadaPeloProduto` é a régua:
// marcador `gitorch:node:...` no corpo (a árvore do backlog-executor) OU
// etiqueta `gitorch:agent:*` (quem tocou a issue) — os DOIS sinais que só um
// agente do produto deixa.

/** Uma issue aberta, do jeito mínimo que o backfill precisa dela. */
export interface IssueParaBackfillDeQuadro {
  number: number
  nodeId: string
  labels: string[]
  corpo: string | null
}

export interface DepsDoBackfillDeQuadro {
  /** As issues abertas do repositório, cruas — o filtro roda AQUI, não na chamada. */
  listarIssuesAbertas(): Promise<IssueParaBackfillDeQuadro[]>
  /** Números que JÁ estão no quadro — candidata aqui não vira segunda tentativa. */
  numerosJaNoQuadro(): Promise<Set<number>>
  /** Adiciona ao quadro (idempotente do lado do GitHub); devolve o id do item. */
  adicionarAoQuadro(nodeId: string): Promise<string>
  /**
   * Teto do LOTE desta passada — nunca esconde quantas ficaram de fora
   * (`candidatas` no resultado continua contando todas). Sem limite,
   * tenta todas as candidatas que ainda não estão no quadro.
   */
  limite?: number
}

export interface ResultadoDoBackfillDeQuadro {
  totalAbertas: number
  /** Quantas das abertas são do PRODUTO (marcador ou etiqueta de agente). */
  candidatas: number
  /** Das candidatas, quantas já estavam no quadro antes desta passada. */
  jaNoQuadro: number
  /** Quantas foram adicionadas AGORA (respeitando `limite`, se houver). */
  adicionadasAgora: number
  /** Os números das issues adicionadas nesta passada, na ordem. */
  issuesAdicionadas: number[]
}

const MARCADOR_DE_NO = /gitorch:node:\d+:(phase|epic|feature|task):\d+/

/**
 * Esta issue é trabalho que o PRODUTO criou ou tocou?
 *
 * Dois sinais, cada um suficiente sozinho: o marcador que `backlog-executor.ts`
 * grava em TODO nó da árvore (phase/epic/feature/task), e a etiqueta
 * `gitorch:agent:*` que qualquer papel (po/qa/sm/ra/jules) deixa ao mexer numa
 * issue. Nenhum dos dois aparece em "wishlist" (o pedido cru do dono, antes de
 * virar plano) nem em "security" (alerta do Dependabot) — medido ao vivo:
 * as 11 issues sem marcador nem etiqueta de agente do repositório real eram
 * exatamente essas duas categorias, e nenhuma delas é obra do produto.
 */
export function issueECriadaPeloProduto(issue: IssueParaBackfillDeQuadro): boolean {
  if (MARCADOR_DE_NO.test(issue.corpo ?? '')) return true
  return issue.labels.some((label) => label.startsWith('gitorch:agent:'))
}

/**
 * A passada de catch-up: adiciona ao quadro as issues abertas que o produto
 * já criou/tocou e que ainda não estão lá.
 *
 * EM SÉRIE, de propósito — mesmo motivo de `backfillPesoDosItensExistentes`:
 * é uma passada de manutenção sobre o quadro REAL do cliente, e uma falha no
 * meio SOBE crua (nunca mascarada) para quem chamou saber exatamente onde
 * parou — `issuesAdicionadas` já lista o que deu certo até ali.
 */
export async function backfillItensNoQuadro(
  deps: DepsDoBackfillDeQuadro
): Promise<ResultadoDoBackfillDeQuadro> {
  const abertas = await deps.listarIssuesAbertas()
  const candidatas = abertas.filter(issueECriadaPeloProduto)
  const jaNoQuadro = await deps.numerosJaNoQuadro()

  const paraTentar = candidatas.filter((i) => !jaNoQuadro.has(i.number))
  const lote =
    typeof deps.limite === 'number' && deps.limite >= 0
      ? paraTentar.slice(0, deps.limite)
      : paraTentar

  const issuesAdicionadas: number[] = []
  for (const issue of lote) {
    await deps.adicionarAoQuadro(issue.nodeId)
    issuesAdicionadas.push(issue.number)
  }

  return {
    totalAbertas: abertas.length,
    candidatas: candidatas.length,
    jaNoQuadro: candidatas.length - paraTentar.length,
    adicionadasAgora: issuesAdicionadas.length,
    issuesAdicionadas,
  }
}
