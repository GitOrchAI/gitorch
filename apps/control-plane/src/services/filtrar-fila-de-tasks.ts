import { ESCALA_DE_PESO, type PedidoNaFila, type PesoDeTask } from '@gitorch/cadence'

// D9 (01/09) — a fila da D1 ("Sua ordem custa caro?") só pode considerar
// TASKS, nunca a lista inteira do quadro.
//
// A REGRA ANTIGA em `custo-da-ordem-do-projeto.ts` (scheduler.ts,
// `filaDoQuadro`) dizia: se ALGUM item da fila estiver sem peso, fica em
// silêncio. A INTENÇÃO estava certa — "nunca inventa um peso que não tem" —
// mas o DEFEITO era outro: a fila lida do quadro incluía fase, épico,
// feature e incidente, e o produto só atribui peso a TASK, por desenho (ver
// backlog-executor.ts — só `ensureNode` de task grava a seção "## Peso").
//
// Medido no quadro real GitOrchAI #2, 01/09: 124 itens, 48 eram fase, épico,
// feature ou incidente. "Todo item da fila com peso" era uma condição
// ESTRUTURALMENTE inalcançável — os 48 nunca teriam peso, e a D1 nunca
// disparava.
//
// O CONSERTO: filtrar a fila para SÓ TASK antes de aplicar a prudência do
// peso. O tipo de cada item já é conhecido — o backlog-executor grava o
// marcador `gitorch:node:<wish>:tipo:i` no corpo de toda issue que cria
// (mesmo marcador que `scheduler.ts` já usa em `varrerArvoreDoPlano` para
// distinguir nível, e que `github-backlog.ts` usa para achar issue por
// marker). Comparar por ESTE marcador, nunca por título — comparação por
// nome já colidiu neste projeto (acme-api vs acme_api, ver
// decisao-escolha-de-quadro).

/** Um item cru do quadro, do jeito mínimo que este filtro precisa dele. */
export interface ItemDoQuadroParaFiltrar {
  pedido: number
  peso: number | null
  /** O corpo (markdown) da issue — onde mora o marcador `gitorch:node:...`. */
  corpo: string | null
}

/**
 * Por que a fila ainda não pode ser calculada — para o chamador poder logar
 * QUANTO falta e POR QUÊ, em vez de um silêncio que não distingue "não há o
 * que avisar" de "não consegui calcular" (o mesmo defeito de observabilidade
 * já visto em L3-T23).
 */
export type MotivoDoSilencioDaFila =
  /** Quadro sem task nenhuma (só agrupadores, ou vazio) — silêncio normal. */
  | { motivo: 'sem-task-nenhuma' }
  /** Uma ou mais tasks ainda sem peso planejado — o caso mais comum. */
  | { motivo: 'sem-peso'; totalDeTasks: number; semPeso: number[] }
  /** Campo "Peso" com valor fora de 1,2,3,5,8,13 — alguém mexeu por fora. */
  | { motivo: 'peso-fora-da-escala'; totalDeTasks: number; pedidos: number[] }

export type ResultadoDoFiltroDeTasks =
  { fila: PedidoNaFila[] } | ({ fila: null } & MotivoDoSilencioDaFila)

const MARCADOR_DE_TASK = /gitorch:node:\d+:task:\d+/

/**
 * Reduz a fila crua do quadro à fila de TASKS com peso conhecido — a única
 * fila que `analisarCustoDaOrdem` (packages/cadence) sabe calcular. Fase,
 * épico e feature são agrupadores; incidente é outro fluxo inteiro
 * (`gitorch:incident:...`); um item sem marcador nenhum (criado à mão pelo
 * cliente direto no quadro) também fica de fora — nunca trava a fila dos
 * outros.
 *
 * MANTÉM a prudência de antes: task sem peso conhecido continua fazendo a
 * conta ficar em silêncio (`fila: null`) — só parou de exigir peso de quem
 * nunca vai ter.
 */
export function filtrarFilaDeTasks(itens: ItemDoQuadroParaFiltrar[]): ResultadoDoFiltroDeTasks {
  const tasks = itens.filter((i) => MARCADOR_DE_TASK.test(i.corpo ?? ''))

  if (tasks.length === 0) return { fila: null, motivo: 'sem-task-nenhuma' }

  const semPeso = tasks.filter((i) => i.peso === null).map((i) => i.pedido)
  if (semPeso.length > 0) {
    return { fila: null, motivo: 'sem-peso', totalDeTasks: tasks.length, semPeso }
  }

  // Fora da ESCALA_DE_PESO (alguém digitou outra coisa no campo "Peso" pela
  // interface do GitHub, fora do que o produto escreve): mesma prudência de
  // backlog-executor.ts — não presume que serve.
  const foraDaEscala = tasks
    .filter((i) => !(ESCALA_DE_PESO as readonly number[]).includes(i.peso as number))
    .map((i) => i.pedido)
  if (foraDaEscala.length > 0) {
    return {
      fila: null,
      motivo: 'peso-fora-da-escala',
      totalDeTasks: tasks.length,
      pedidos: foraDaEscala,
    }
  }

  return { fila: tasks.map((i) => ({ pedido: i.pedido, peso: i.peso as PesoDeTask })) }
}
