/**
 * Decide o que fazer diante do estado da verificação automática do repositório.
 *
 * Julgar com a verificação ainda rodando já prendeu uma entrega para sempre:
 * o juiz reprovava por não saber, e depois pulava a revisão porque já tinha
 * opinado sobre aquele mesmo código. Por isso pendente NUNCA vira veredito.
 * Mas esperar calado para sempre também é falha: passado o teto, o dono é
 * avisado de que a verificação daquele repositório está parada.
 */

/**
 * Estados possíveis lidos do repositório. `sem-resultado`: nada falhou de
 * verdade e nada provou que passou (execução cancelada por push novo ou
 * concorrência, obsoleta, pulada, ou que nem chegou a existir neste commit).
 * Cai na MESMA régua de pending/unknown logo abaixo: nunca vira veredito
 * sozinho.
 */
export type EstadoDaVerificacao =
  'green' | 'red' | 'pending' | 'no checks' | 'unknown' | 'sem-resultado'

/** Quanto tempo uma verificação pode ficar pendente antes de virar aviso. */
export const TETO_DE_ESPERA_MS = 90 * 60 * 1000

export interface DecisaoDaVerificacao {
  acao: 'julgar' | 'esperar' | 'avisar-demora'
  motivo: string
}

export function decidirSobreVerificacao(args: {
  estado: EstadoDaVerificacao
  /** Quando o produto viu esta entrega pendente pela primeira vez. */
  primeiraVezVistoPendenteEm: Date | null
  agora: Date
  /** Por que não há resultado, em linguagem simples (só para `sem-resultado`). */
  detalhe?: string | undefined
}): DecisaoDaVerificacao {
  if (args.estado === 'green') return { acao: 'julgar', motivo: 'verificação verde' }
  if (args.estado === 'red') return { acao: 'julgar', motivo: 'verificação vermelha' }
  if (args.estado === 'no checks') {
    return { acao: 'julgar', motivo: 'repositório sem verificação automática' }
  }

  // pending, unknown e sem-resultado caem aqui: nunca viram veredito.
  const desde = args.primeiraVezVistoPendenteEm
  if (desde !== null && args.agora.getTime() - desde.getTime() > TETO_DE_ESPERA_MS) {
    return {
      acao: 'avisar-demora',
      motivo: 'a verificação está parada muito além do esperado',
    }
  }
  if (args.estado === 'sem-resultado') {
    const porque = args.detalhe ? ` (${args.detalhe})` : ''
    return { acao: 'esperar', motivo: `sem resultado de verificação${porque}` }
  }
  return { acao: 'esperar', motivo: `verificação em ${args.estado}` }
}
