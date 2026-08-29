// ESTEIRA-T15 (decisão do dono 29/08). O dono recebeu, em 29/08, uma rajada de
// avisos de rotina no Telegram: "3 entregas barradas... Parei de reencaminhar",
// "4 entregas barradas", "5", "issue #318 voltou para a fila" — quatro
// mensagens em cinco minutos, nenhuma pedindo uma decisão dele. "isso me torna
// um caos... pode afetar caso venha uma mensagem importante".
//
// A régua: Telegram é para o que exige o DONO — uma decisão a tomar, um marco
// de entrega no ar, um incidente que precisa da atenção dele. Progresso e
// auditoria de rotina (contadores, filas, o que o sensor achou) nunca
// deveriam ter ido para lá — viram linha em `events` (tipo `audit`) e
// aparecem na timeline do Painel, sem sumir, só mudando de canal.
//
// O padrão é reconhecer FRASES DE ROTINA já conhecidas, não adivinhar
// intenção: o default é `executivo` (o lado seguro é o dono ver um aviso a
// mais, nunca ficar sem saber de uma decisão que era dele).

export type ClasseDoAviso = 'executivo' | 'auditoria'

/**
 * Frases que identificam auditoria/progresso — os exemplos reais da rajada de
 * 29/08, mais os outros padrões de rotina do mesmo formato.
 */
const PADROES_DE_AUDITORIA: RegExp[] = [
  /\bentregas?\s+(seguidas\s+)?barradas?\b/i,
  /\bparei de reencaminhar\b/i,
  /\bvolt(ou|aram) (para|pra) a fila\b/i,
  /\bEncanamento do GitOrch\b/i,
]

/** Para onde esta mensagem deveria ir: Telegram (executivo) ou timeline (auditoria). */
export function classificarAviso(mensagem: string): ClasseDoAviso {
  return PADROES_DE_AUDITORIA.some((padrao) => padrao.test(mensagem)) ? 'auditoria' : 'executivo'
}
