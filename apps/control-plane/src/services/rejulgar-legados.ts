/**
 * A reprovação emitida sob uma leitura do CI que hoje se sabe errada.
 *
 * Em 24/08 o produto passou a aceitar job `skipped` como parte de um CI verde
 * (antes ele contava como falha, e três jobs condicionais faziam o
 * `loureng/patinhas-3d-crafts` NUNCA ter CI verde). Toda reprovação emitida
 * ANTES dessa correção foi julgada com a régua velha.
 *
 * Isso deixou PRs presos para sempre: o laço de descoberta pula quem já tem
 * parecer no mesmo commit, e a marca que permite reabrir só existe em pareceres
 * emitidos depois do conserto. Os antigos não a têm — e o corpo de uma
 * reprovação de CÓDIGO é IDÊNTICO ao de uma reprovação do portão
 * ("GitOrch QA verdict: REQUEST CHANGES (see comment)"), então ler o texto não
 * distingue uma da outra.
 *
 * A saída não é afrouxar trava nenhuma: é dar UM rejulgamento a quem foi
 * julgado pela régua velha e, pela régua de hoje, está verde. Se o código tiver
 * defeito de verdade, o QA reprova de novo — só que agora dizendo por quê.
 */

/**
 * Quando a régua mudou: o instante em que a correção do `skipped` entrou NO AR
 * (PR #182). É o DEPLOY que conta, nunca o merge — entre um e outro o processo
 * em produção ainda roda o binário velho, e uma reprovação publicada nessa
 * janela foi julgada pela régua antiga apesar do código novo já estar na main.
 *
 * Por isso o corte fica FOLGADO, um pouco depois do reinício observado
 * (04:29Z), e não colado nele. Os dois erros possíveis não custam igual:
 * incluir demais dá um rejulgamento a quem já fora julgado pela régua nova, e
 * o QA simplesmente julga de novo; incluir de menos deixa o PR preso para
 * sempre, que é exatamente o defeito que isto existe para consertar.
 *
 * É um CORTE, não uma janela deslizante: reprovação posterior a isto já foi
 * julgada pela régua nova e não ganha nada. Sem o corte, este caminho viraria
 * uma segunda chance permanente para qualquer reprovação — exatamente a trava
 * que ninguém pode afrouxar.
 */
export const REGUA_MUDOU_EM = new Date('2026-08-24T05:00:00Z')

export interface EntregaPresa {
  numero: number
  /** O commit no topo do PR AGORA. */
  headAtual: string
  /** O commit sobre o qual a reprovação foi escrita. */
  headJulgado: string | null
  /** Quando a reprovação foi publicada. */
  reprovadaEm: Date | null
  /**
   * O CI daquele head, pela régua de HOJE. `cancelado` (L4-T17): tudo
   * cancelou e nada falhou de verdade — cai no MESMO "não é green" das
   * linhas abaixo, então não muda a decisão, só o rótulo no motivo.
   */
  ciHoje: 'green' | 'red' | 'pending' | 'no checks' | 'unknown' | 'cancelado'
  /** O produto encomendou esta entrega? Só ela é nossa para mesclar. */
  delegada: boolean
  /** Já recebeu o rejulgamento de cortesia? */
  jaRejulgada: boolean
}

export type DecisaoSobreLegado =
  { acao: 'rejulgar'; motivo: string } | { acao: 'deixar'; motivo: string }

/**
 * Esta entrega merece UM rejulgamento?
 *
 * Cada recusa tem motivo próprio: sem eles, "não rejulguei" viraria um silêncio
 * indistinguível de um defeito na varredura.
 */
export function decidirSobreLegado(entrega: EntregaPresa): DecisaoSobreLegado {
  // Entrega que o produto não encomendou não é nossa para mesclar — a mesma
  // regra que vale no julgamento normal, e ela não afrouxa aqui.
  if (!entrega.delegada) {
    return { acao: 'deixar', motivo: 'não foi o produto que encomendou esta entrega' }
  }

  // UMA vez. Sem isto, um PR que continua vermelho por mérito seria reaberto a
  // cada varredura, virando opinião repetida no pull request do cliente.
  if (entrega.jaRejulgada) {
    return { acao: 'deixar', motivo: 'já recebeu o rejulgamento' }
  }

  if (!entrega.reprovadaEm || !Number.isFinite(entrega.reprovadaEm.getTime())) {
    return { acao: 'deixar', motivo: 'não dá para saber quando foi reprovada' }
  }

  // Depois do corte já foi julgada pela régua nova.
  if (entrega.reprovadaEm.getTime() >= REGUA_MUDOU_EM.getTime()) {
    return { acao: 'deixar', motivo: 'reprovada já sob a régua de hoje' }
  }

  // O CÓDIGO PRECISA SER O MESMO. Se o dev empurrou commit depois da
  // reprovação, o caminho normal já reabre a entrega — e rejulgar aqui seria
  // opinar sobre um código que ninguém reprovou.
  if (!entrega.headJulgado || entrega.headJulgado !== entrega.headAtual) {
    return { acao: 'deixar', motivo: 'o código mudou desde a reprovação; o caminho normal cuida' }
  }

  // Verde pela régua de HOJE é a evidência inteira: a reprovação de então foi
  // escrita sobre uma leitura que o produto já corrigiu.
  if (entrega.ciHoje !== 'green') {
    return {
      acao: 'deixar',
      motivo: `a verificação continua "${entrega.ciHoje}" pela régua de hoje`,
    }
  }

  return {
    acao: 'rejulgar',
    motivo:
      'reprovada antes da correção da leitura do CI, no mesmo commit, e hoje a verificação está verde',
  }
}

/**
 * As entregas a rejulgar, com o motivo de cada uma que ficou de fora — quem
 * lê o relatório precisa saber por que o PR dele não se mexeu.
 */
export function trocarLegadosPorRejulgamento(entregas: EntregaPresa[]): {
  rejulgar: number[]
  deixadas: Array<{ numero: number; motivo: string }>
} {
  const rejulgar: number[] = []
  const deixadas: Array<{ numero: number; motivo: string }> = []
  for (const e of entregas) {
    const d = decidirSobreLegado(e)
    if (d.acao === 'rejulgar') rejulgar.push(e.numero)
    else deixadas.push({ numero: e.numero, motivo: d.motivo })
  }
  return { rejulgar, deixadas }
}
