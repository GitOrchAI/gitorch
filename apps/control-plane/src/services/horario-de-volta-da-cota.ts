/**
 * Quando a cota de um motor volta — texto do provedor vira Date, para a
 * missão poder DORMIR até lá em vez de morrer 'failed'.
 *
 * DECISÃO DO DONO (10/09/2026, produção): antigravity respondendo "Error:
 * Individual quota reached. Please upgrade your subscription to increase
 * your limits. Resets in 7h22m10s." e codex "You've hit your usage limit
 * ... try again at Sep 21st, 2026 6:00 AM" faziam a cadeia INTEIRA de
 * motores esgotar e `executeMissionWithFailover` (scheduler.ts) marcava a
 * missão 'failed' — o papel voltava a ser disparado minutos depois pela
 * agenda, sem nenhum motor com cota disponível. Medido: 244 missões de QA
 * 'failed' em 24h, sem nenhum trabalho feito. A ordem do dono: "não tem
 * cota? tudo bem, aguarda. Sem falha, sem mensagem."
 *
 * `quandoACotaVolta` (teto-de-uso-da-conta.ts) já extrai o TEXTO cru do
 * prazo ("8h10m" ou a data absoluta) para o recado que o dono lê — mas
 * texto não dá para comparar "já passou?" nem escolher o MENOR entre vários
 * motores, e não cobre segundos sozinhos ("Resets in 45s", visto em
 * produção quando o prazo está quase acabando). Este arquivo faz o passo
 * que faltava: texto → Date, e reaproveita (não duplica) a detecção de
 * "isto é erro de cota" que já existe em `ehTetoDeUsoDaConta`.
 */

// "Resets in 8h10m12s" / "Resets in 5m11s" / "Resets in 45s" — qualquer
// combinação de h/m/s, na ordem, todos os componentes opcionais (a
// exigência de que ao menos um exista é feita pelo chamador abaixo).
const RELATIVO = /resets?\s+in\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i

const MESES: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
}

// "Sep 21st, 2026 6:00 AM" — dia com sufixo ordinal opcional (st/nd/rd/th),
// hora em formato 12h com AM/PM. Formato medido ao vivo no Codex.
const ABSOLUTO =
  /([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i

/**
 * Texto do provedor → o instante em que a cota volta, ou `null` quando o
 * texto não traz prazo nenhum (o chamador decide o padrão — inventar um
 * prazo aqui seria pior que admitir que não se sabe).
 *
 * PREMISSA (documentada, não verificada com o provedor): o formato absoluto
 * ("try again at ...") não diz o fuso horário. Assume-se UTC. Um erro de
 * fuso aqui é barato dos dois lados — o produto tenta o motor cedo demais
 * (uma tentativa a mais, o preço de sempre de "tentar e falhar") ou tarde
 * demais (motor ocioso por mais algumas horas) — nunca inventa um fuso que
 * ninguém disse.
 */
export function parseHorarioDeVoltaDaCota(texto: string, agora: Date): Date | null {
  const relativo = RELATIVO.exec(texto)
  if (relativo && (relativo[1] || relativo[2] || relativo[3])) {
    const horas = relativo[1] ? parseInt(relativo[1], 10) : 0
    const minutos = relativo[2] ? parseInt(relativo[2], 10) : 0
    const segundos = relativo[3] ? parseInt(relativo[3], 10) : 0
    const totalMs = ((horas * 60 + minutos) * 60 + segundos) * 1000
    return new Date(agora.getTime() + totalMs)
  }

  const absoluto = ABSOLUTO.exec(texto)
  if (absoluto) {
    const [, mesTexto, diaTexto, anoTexto, horaTexto, minutoTexto, meridiano] = absoluto
    const mes = MESES[(mesTexto ?? '').toLowerCase().slice(0, 3)]
    if (mes === undefined) return null
    const dia = parseInt(diaTexto as string, 10)
    const ano = parseInt(anoTexto as string, 10)
    let hora = parseInt(horaTexto as string, 10) % 12
    if ((meridiano ?? '').toUpperCase() === 'PM') hora += 12
    const minuto = parseInt(minutoTexto as string, 10)
    const data = new Date(Date.UTC(ano, mes, dia, hora, minuto, 0))
    return Number.isNaN(data.getTime()) ? null : data
  }

  return null
}

/**
 * "Isto é a conta batendo no teto de uso?" — reaproveitado, não duplicado:
 * a mesma pergunta já existe em `ehTetoDeUsoDaConta` (teto-de-uso-da-conta.ts),
 * verificada contra saída real do Antigravity e do Codex. Renomeado aqui só
 * para o vocabulário desta tarefa (DJ-T4): "erro de cota", o que decide se
 * um degrau da cascata entra em `voltasDaCota` (scheduler.ts).
 */
export { ehTetoDeUsoDaConta as ehErroDeCota } from './teto-de-uso-da-conta.js'

/**
 * O menor horário de volta entre os motores da cadeia — a hora certa de
 * retomar é a do motor que volta PRIMEIRO, nunca a do último. Lista vazia
 * devolve `null`: o chamador (scheduler.ts) já tem um prazo padrão pronto
 * para quando nenhum motor da cascata disse uma data (motores esgotados sem
 * `Resets in`/`try again at` no texto).
 */
export function menorHorarioDeVolta(datas: Date[]): Date | null {
  if (datas.length === 0) return null
  return datas.reduce((menor, atual) => (atual < menor ? atual : menor))
}
