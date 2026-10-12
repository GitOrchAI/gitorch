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

const TAMANHO_DO_MOTIVO = 160

/**
 * O motivo que o GitHub deu, em uma linha curta e sem credencial.
 *
 * Um 403 pode ser cota, falta de permissão, recurso desligado no repositório
 * ou issue de outro dono — e só a mensagem do corpo distingue. Sem ela o aviso
 * culpava a credencial mesmo quando o recurso estava apenas desligado.
 * O texto vem de serviço externo: tira o que parece token, cabeçalho de
 * autorização ou endereço (que pode carregar usuário e senha) antes de sair.
 */
export function resumirMotivoDoGitHub(corpo: string): string {
  let texto = corpo
  try {
    const json: unknown = JSON.parse(corpo)
    if (json !== null && typeof json === 'object' && 'message' in json) {
      const m = (json as { message: unknown }).message
      texto = typeof m === 'string' ? m : ''
    } else {
      texto = ''
    }
  } catch {
    // Não é JSON: o texto cru, enxuto, ainda explica.
  }
  return (
    texto
      .replace(/https?:\/\/\S+/gi, '[endereço]')
      .replace(/\bgh[pousr]_[A-Za-z0-9_]+/g, '[credencial]')
      .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, '[credencial]')
      .replace(/\bBearer\s+\S+/gi, '[credencial]')
      // `token <valor>` (cabeçalho do estilo antigo): exige valor longo ou com
      // dígito, para a palavra "token" em frase comum ("token expired") sobreviver.
      .replace(/\btoken\s+(?:\S{20,}|(?=\S*\d)\S{8,})/gi, '[credencial]')
      // JWT: três blocos base64url separados por ponto (assinatura do App, por exemplo).
      .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[credencial]')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, TAMANHO_DO_MOTIVO)
  )
}

/** Lê o corpo de uma resposta ruim (numa cópia) e devolve o motivo; nunca lança. */
export async function lerMotivoDaResposta(resposta: Response): Promise<string> {
  try {
    return resumirMotivoDoGitHub(await resposta.clone().text())
  } catch {
    return ''
  }
}
