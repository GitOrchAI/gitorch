// O erro de uma chamada ao GitHub que voltou fora de 2xx, com os cabeçalhos
// que dizem SE a causa é cota (e até quando) ou outra coisa (permissão, item
// apagado). Antes, o 403 virava só "failed (403)" e o motivo se perdia: não
// dava para distinguir limite de taxa de falta de permissão.
//
// A mensagem é a MESMA de antes — quem a lê (logs, testes, `.message`) segue
// funcionando; o que muda é que o erro agora carrega os números.

/** O pedaço da `Response` de que este módulo precisa (aceita a real e um fake). */
export interface RespostaComCabecalhos {
  status: number
  headers: { get(nome: string): string | null }
}

export class ErroDoGitHub extends Error {
  readonly status: number
  /** `retry-after`, em segundos (limite secundário). */
  readonly retryAfterSegundos: number | null
  /** `x-ratelimit-remaining`: chamadas que sobram na janela. */
  readonly limiteRestante: number | null
  /** `x-ratelimit-reset`: instante do reset, em segundos desde 1970. */
  readonly limiteResetaEmSegundos: number | null

  constructor(
    mensagem: string,
    dados: {
      status: number
      retryAfterSegundos: number | null
      limiteRestante: number | null
      limiteResetaEmSegundos: number | null
    }
  ) {
    super(mensagem)
    this.name = 'ErroDoGitHub'
    this.status = dados.status
    this.retryAfterSegundos = dados.retryAfterSegundos
    this.limiteRestante = dados.limiteRestante
    this.limiteResetaEmSegundos = dados.limiteResetaEmSegundos
  }
}

function numeroDoCabecalho(resposta: RespostaComCabecalhos, nome: string): number | null {
  const bruto = resposta.headers.get(nome)
  if (bruto === null || bruto.trim() === '') return null
  const valor = Number(bruto)
  return Number.isFinite(valor) ? valor : null
}

export function erroDaRespostaDoGitHub(
  mensagem: string,
  resposta: RespostaComCabecalhos
): ErroDoGitHub {
  return new ErroDoGitHub(mensagem, {
    status: resposta.status,
    retryAfterSegundos: numeroDoCabecalho(resposta, 'retry-after'),
    limiteRestante: numeroDoCabecalho(resposta, 'x-ratelimit-remaining'),
    limiteResetaEmSegundos: numeroDoCabecalho(resposta, 'x-ratelimit-reset'),
  })
}
