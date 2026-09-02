import {
  avaliarPronto,
  normalizarRegua,
  O_QUE_O_CRITERIO_EXIGE,
  type CriterioDePronto,
  type FatosDaEntrega,
  type VeredictoDePronto,
} from '@gitorch/cadence'

// Registrar que uma entrega ficou PRONTA.
//
// A régua (quais critérios contam) mora em packages/cadence — é regra
// determinista, do mesmo jeito que a autonomia, e os três motores enxergam o
// mesmo veredito. Aqui é só o encanamento: pegar os fatos que o banco já tem,
// perguntar à régua, e gravar quando ela disser que sim.
//
// NADA DE RASTREIO NOVO. Todo fato usado já é gravado pelo caminho que roda
// hoje (dev_sessions). Uma segunda fonte da verdade sobre "isto ficou pronto"
// divergiria da primeira em algum momento, e o dono descobriria pelo número
// errado.

/** Uma entrega candidata, do jeito que o banco a tem. */
export interface EntregaCandidata extends FatosDaEntrega {
  projectId: string
  issueNumber: number
  wishCreatedAt?: string
  mergedAt?: string
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
  gravar: (dados: {
    projectId: string
    issueNumber: number
    pullRequestNumber: number | null
    mergeCommitSha: string | null
    reguaAplicada: Record<CriterioDePronto, boolean>
    criterios: CriterioDePronto[]
    wishCreatedAt?: string
    mergedAt?: string
  }) => Promise<void>
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
    ...(entrega.wishCreatedAt && { wishCreatedAt: entrega.wishCreatedAt }),
    ...(entrega.mergedAt && { mergedAt: entrega.mergedAt }),
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
