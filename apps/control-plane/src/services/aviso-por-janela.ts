// ESTEIRA-T11 (e reusado pelo T15): "avisa o dono UMA vez por janela".
// Um problema que persiste (esteira travada por vaga, entregas barradas...)
// não pode virar spam a cada acordada — foi reclamação direta do dono. A regra
// pura: começou agora → registra o início e NÃO avisa; persistiu além do prazo
// e ainda não avisou → avisa e marca; persistiu e já avisou → silêncio;
// sumiu → limpa a marca (a próxima ocorrência é um evento novo).

export interface EstadoDaJanela {
  /** Quando o problema começou. `null` = não está no problema. */
  desde: Date | null
  /** Já avisou o dono nesta janela? */
  avisado: boolean
}

/**
 * Estado "sem problema". CONGELADO: é devolvido para consumidores que só leem
 * (`decidirAvisoPorJanela` devolve uma cópia nova, não esta referência) e uma
 * mutação acidental aqui contaminaria toda chamada seguinte do módulo.
 */
export const JANELA_LIMPA: Readonly<EstadoDaJanela> = Object.freeze({ desde: null, avisado: false })

export interface DecisaoDeAviso {
  novoEstado: EstadoDaJanela
  deveAvisar: boolean
  /** Há quanto tempo (min) o problema persiste — para o texto do aviso. */
  minutosNoProblema: number
}

export function decidirAvisoPorJanela(
  estado: EstadoDaJanela,
  problemaAgora: boolean,
  agora: Date,
  minutosAteAlertar: number
): DecisaoDeAviso {
  if (!problemaAgora) {
    // Cópia nova a cada chamada — nunca a referência de `JANELA_LIMPA`.
    return { novoEstado: { desde: null, avisado: false }, deveAvisar: false, minutosNoProblema: 0 }
  }
  const desde = estado.desde ?? agora
  const minutosNoProblema = Math.floor((agora.getTime() - desde.getTime()) / 60_000)
  if (estado.avisado) {
    return { novoEstado: { desde, avisado: true }, deveAvisar: false, minutosNoProblema }
  }
  if (minutosNoProblema >= minutosAteAlertar) {
    return { novoEstado: { desde, avisado: true }, deveAvisar: true, minutosNoProblema }
  }
  return { novoEstado: { desde, avisado: false }, deveAvisar: false, minutosNoProblema }
}
