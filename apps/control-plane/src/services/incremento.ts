import {
  avaliarPronto,
  normalizarRegua,
  O_QUE_O_CRITERIO_EXIGE,
  type CriterioDePronto,
  type FatosDaEntrega,
  type VeredictoDePronto,
} from '@gitorch/cadence'
import type { Origem } from './enriquecer-incremento.js'

// Registrar que uma entrega ficou PRONTA.
//
// A régua (quais critérios contam) mora em packages/cadence — é regra
// determinista, do mesmo jeito que a autonomia, e os três motores enxergam o
// mesmo veredito. Aqui é só o encanamento: pegar os fatos que o banco já tem,
// perguntar à régua, e gravar quando ela disser que sim.
//
// NADA DE RASTREIO NOVO. Todo fato usado já é gravado pelo caminho que roda
// hoje (dev_sessions) ou já existe no GitHub (enriquecer-incremento.ts). Uma
// segunda fonte da verdade sobre "isto ficou pronto" divergiria da primeira
// em algum momento, e o dono descobriria pelo número errado.

/**
 * Os quatro campos do desenho (D3) que a régua não julga, só registra —
 * quem tocou e a origem respondem "cadê o gitorch trabalhando?"; sprint e
 * peso vêm do GitHub, já lidos por `buscarCamposDoIncremento`
 * (enriquecer-incremento.ts). Sem valor DEFAULT de propósito: cada chamador
 * decide, e o compilador cobra a decisão — a mesma regra que `peso` já usa
 * em backlog-executor.ts (nulo é uma resposta; esquecido não é).
 */
export interface CamposDoDesenho {
  sprint: string | null
  /** "O que era" — o título da issue. */
  titulo: string | null
  /** "Quanto pesava" — escala 1,2,3,5,8,13, quando a task teve estimativa. */
  peso: number | null
  /**
   * Quem produziu a entrega. Hoje só existe UM caminho de escrita do
   * Incremento (registrarPublicacaoEIncremento, scheduler.ts) e ele SÓ roda
   * para sessões do dev assíncrono — por isso, aqui, é sempre 'gitorch'. Um
   * futuro caminho para merge feito à mão pelo dono gravaria 'dono'.
   */
  quemTocou: 'gitorch' | 'dono'
  /** Nasceu de uma wish do dono (pedido) ou o produto criou por conta própria. */
  pedidoOuProativo: Origem
  /** Quando o DESEJO nasceu — o INÍCIO do ciclo do item (D4), não desta task. */
  wishCreatedAt: Date | null
  /** Quando o PR mesclou, lido do GitHub. */
  mergedAt: Date | null
}

/** Uma entrega candidata, do jeito que o banco a tem. */
export interface EntregaCandidata extends FatosDaEntrega, CamposDoDesenho {
  projectId: string
  issueNumber: number
}

/** O que a tela mostra de cada entrega. */
export interface EntregaDoPainel {
  projeto: string
  pedido: number
  entrega: number | null
  pronto: boolean
  /** Quando ficou pronto (ISO). Nulo enquanto não fechou. */
  prontoEm: string | null
  /** O que cada critério atendido exige, escrito. */
  atendidos: string[]
  /** O que falta, escrito para o cliente ler. Vazio quando está pronto. */
  porQueNaoFechou: string[]
}

export interface DepsDoIncremento {
  /** A régua daquele projeto, como veio do banco. `null` = padrão do produto. */
  lerRegua: (projectId: string) => Promise<unknown>
  /** Grava o Incremento. Idempotente por (projeto, pedido). */
  gravar: (
    dados: {
      projectId: string
      issueNumber: number
      pullRequestNumber: number | null
      mergeCommitSha: string | null
      reguaAplicada: Record<CriterioDePronto, boolean>
      criterios: CriterioDePronto[]
    } & CamposDoDesenho
  ) => Promise<void>
  /** Já existe Incremento para este pedido? */
  jaRegistrado: (projectId: string, issueNumber: number) => Promise<boolean>
}

/**
 * Passa a entrega pela régua e, se fechou, registra.
 *
 * Devolve o veredito SEMPRE — inclusive quando não fechou. O que falta é a
 * parte que não pode se perder: uma entrega parada sem ninguém dizer por quê é
 * o silêncio que este bloco veio acabar.
 *
 * A régua é copiada para dentro do registro. Sem isso, mudar a régua amanhã
 * reescreveria a história: uma entrega de ontem passaria a parecer que atendeu
 * critérios que ninguém exigia dela.
 */
export async function registrarSePronto(
  deps: DepsDoIncremento,
  entrega: EntregaCandidata
): Promise<VeredictoDePronto> {
  const regua = normalizarRegua(await deps.lerRegua(entrega.projectId))
  const veredito = avaliarPronto(entrega, regua)

  if (!veredito.pronto) return veredito

  // Registrar duas vezes o mesmo pedido faria o painel contar a mesma entrega
  // repetida — um número que só cresce e não quer dizer nada. O índice único
  // no banco é a garantia dura; esta conferência evita o erro barulhento no
  // caminho normal do relógio.
  if (await deps.jaRegistrado(entrega.projectId, entrega.issueNumber)) return veredito

  await deps.gravar({
    projectId: entrega.projectId,
    issueNumber: entrega.issueNumber,
    pullRequestNumber: entrega.pullRequestNumber,
    mergeCommitSha: entrega.mergeCommitSha,
    reguaAplicada: regua,
    criterios: veredito.atendidos,
    sprint: entrega.sprint,
    titulo: entrega.titulo,
    peso: entrega.peso,
    quemTocou: entrega.quemTocou,
    pedidoOuProativo: entrega.pedidoOuProativo,
    wishCreatedAt: entrega.wishCreatedAt,
    mergedAt: entrega.mergedAt,
  })

  return veredito
}

/** Traduz um veredito para o que a tela mostra. */
export function paraTela(args: {
  projeto: string
  pedido: number
  entrega: number | null
  veredito: VeredictoDePronto
  prontoEm: Date | string | null
}): EntregaDoPainel {
  const d = args.prontoEm
  return {
    projeto: args.projeto,
    pedido: args.pedido,
    entrega: args.entrega,
    pronto: args.veredito.pronto,
    prontoEm: d == null ? null : d instanceof Date ? d.toISOString() : d,
    atendidos: args.veredito.atendidos.map((c) => O_QUE_O_CRITERIO_EXIGE[c]),
    porQueNaoFechou: args.veredito.porQueNaoFechou,
  }
}
