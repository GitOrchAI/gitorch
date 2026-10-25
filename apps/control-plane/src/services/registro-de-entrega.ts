// O registro que o produto deixa na issue quando a encerra porque a entrega
// dela já entrou. É só o fato e como desfazer: não diz quem mesclou e não pede
// nada a ninguém (o dono não acompanha o GitHub; dúvida real vai pelo painel).

import { calcularTempoDeResolucao } from '@gitorch/cadence'

/** Quantos PRs o registro cita; passando disso ficam os mais novos. */
const MAX_PRS_CITADOS = 5

/** Marcador oculto: deixa o produto reconhecer o próprio registro e não repeti-lo. */
export const MARCADOR_DO_REGISTRO_DE_ENTREGA = '<!-- gitorch:entregue -->'

/**
 * `pullRequests` em ordem de merge, do mais antigo ao mais novo. Vazio = a
 * entrega está gravada mas o número do pedido não.
 */
export function textoDoRegistroDeEntrega(pullRequests: readonly number[]): string {
  const citados = pullRequests.slice(-MAX_PRS_CITADOS).map((n) => `#${n}`)
  const desfazer = 'Para desfazer: reabrir esta issue.'
  if (citados.length === 0) return `Entregue por uma entrega já mesclada. ${desfazer}`
  if (citados.length === 1) return `Entregue pelo PR ${citados[0]}. ${desfazer}`
  const ultimo = citados[citados.length - 1]
  return `Entregue pelos PRs ${citados.slice(0, -1).join(', ')} e ${ultimo}. ${desfazer}`
}

export function corpoDoRegistroDeEntrega(pullRequests: readonly number[]): string {
  return `${MARCADOR_DO_REGISTRO_DE_ENTREGA}\n${textoDoRegistroDeEntrega(pullRequests)}`
}

/** Algum dos comentários já é o registro do produto? */
export function jaTemRegistroDeEntrega(
  comentarios: ReadonlyArray<{ body?: string | null }>
): boolean {
  return comentarios.some((c) => (c.body ?? '').includes(MARCADOR_DO_REGISTRO_DE_ENTREGA))
}

/**
 * O comentário quando a entrega foi mesclada mas a publicação dela não foi
 * confirmada: só o fato e o motivo. Se o dono precisa saber, o aviso vai pelo
 * painel e Telegram; a issue não fica pedindo que alguém resolva.
 */
export function textoDePublicacaoNaoConfirmada(numeroDoPr: number, motivo: string): string {
  return `A entrega desta tarefa (PR #${numeroDoPr}) foi mesclada, mas o GitOrch não conseguiu confirmar que a publicação dela foi ao ar: ${motivo}`
}

/**
 * O status de "a entrega foi mesclada" que vai para o painel (DJ-T15, D76).
 *
 * Desejo #270 / #344: o dono quer ver quanto tempo a entrega levou desde que
 * o desejo foi escrito até o merge, sem somar datas na mão. O lead time só
 * aparece quando as DUAS datas existem e fazem sentido — sem uma delas (GitHub
 * fora do ar no fechamento, projeto sem credencial, issue sem desejo de
 * origem), a frase some inteira; nunca sai "Lead time: null" nem um número
 * inventado.
 */
export function textoDeEntregaMesclada(args: {
  wingId: string
  mergeCommitSha: string | null | undefined
  motivo: string
  wishCreatedAt: Date | string | null | undefined
  mergedAt: Date | string | null | undefined
}): string {
  const base = `GitOrch: a entrega de ${args.wingId} (commit ${args.mergeCommitSha}) foi mesclada. ${args.motivo}`
  const leadTime = calcularTempoDeResolucao(args.wishCreatedAt, args.mergedAt)
  if (!leadTime) return base
  return `${base} Lead time, do desejo ao merge: ${leadTime}.`
}
