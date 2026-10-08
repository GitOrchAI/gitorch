// Leitura do GitHub para a sondagem e a aplicação das melhorias de segurança.
//
// A resposta ruim NÃO vira exceção: 404, 403 e 422 são o dado (o recurso não
// existe, o plano não dá, falta permissão). Só falha de rede lança, e a
// mensagem de uma falha de rede pode carregar o cabeçalho ou o próprio token,
// então ela passa por `mascararCredenciais` antes de ir adiante.

import { cortarPorPontoDeCodigo, mascararCredenciais, mensagemDoErro } from './texto-seguro.js'
import { repositorioValido } from './nota-de-seguranca.js'

const GITHUB_API = 'https://api.github.com'
const MAXIMO_DA_MENSAGEM = 300

export interface RespostaDoGitHub {
  ok: boolean
  status: number
  /** O JSON da resposta; `null` se vazia ou se não for JSON. */
  corpo: unknown
  /** O `message` do GitHub, mascarado e cortado; `null` se não houver. */
  mensagem: string | null
  /** Limite de taxa (429, ou 403 com cota zerada ou `retry-after`). */
  limitada: boolean
}

export type AoReceberRespostaRuim = (resposta: Response) => void

function eLimiteDeTaxa(resposta: Response): boolean {
  if (resposta.status === 429) return true
  if (resposta.status !== 403) return false
  return (
    resposta.headers.get('retry-after') !== null ||
    resposta.headers.get('x-ratelimit-remaining') === '0'
  )
}

/** Lê a resposta sem nunca lançar por causa do corpo. */
export async function lerRespostaDoGitHub(
  resposta: Response,
  segredos: readonly string[]
): Promise<RespostaDoGitHub> {
  let corpo: unknown = null
  try {
    const texto = await resposta.text()
    if (texto.trim() !== '') corpo = JSON.parse(texto) as unknown
  } catch {
    corpo = null
  }
  let mensagem: string | null = null
  if (typeof corpo === 'object' && corpo !== null) {
    const bruto: unknown = Object.getOwnPropertyDescriptor(corpo, 'message')?.value
    if (typeof bruto === 'string' && bruto.trim() !== '') {
      mensagem = cortarPorPontoDeCodigo(mascararCredenciais(bruto, segredos), MAXIMO_DA_MENSAGEM)
    }
  }
  return {
    ok: resposta.ok,
    status: resposta.status,
    corpo,
    mensagem,
    limitada: eLimiteDeTaxa(resposta),
  }
}

/** O erro de rede como texto seguro (sem a credencial). */
export function erroDeRedeSeguro(erro: unknown, token: string): string {
  return cortarPorPontoDeCodigo(mascararCredenciais(mensagemDoErro(erro), [token]), 300)
}

export function avisarRespostaRuim(
  resposta: Response,
  aoReceberRespostaRuim: AoReceberRespostaRuim | undefined
): void {
  if (resposta.ok || !aoReceberRespostaRuim) return
  try {
    aoReceberRespostaRuim(resposta.clone())
  } catch {
    // O aviso é só para o freio de cota; nunca derruba a leitura.
  }
}

/** Um campo de um objeto de resposta do GitHub, sem confiar no formato. */
export function campoDe(objeto: unknown, ...caminho: string[]): unknown {
  let atual: unknown = objeto
  for (const chave of caminho) {
    if (typeof atual !== 'object' || atual === null) return undefined
    atual = Object.getOwnPropertyDescriptor(atual, chave)?.value
  }
  return atual
}

/**
 * O leitor de um repositório com uma credencial. O repositório é validado uma
 * vez (ele entra na URL de chamadas que levam credencial) e o caminho só pode
 * ser relativo a ele.
 */
export function criarLeitorDeSeguranca(deps: {
  repositorio: string
  token: string
  fetchImpl: typeof fetch
  aoReceberRespostaRuim?: AoReceberRespostaRuim
}): (caminho: string) => Promise<RespostaDoGitHub> {
  if (!repositorioValido(deps.repositorio)) {
    throw new Error('repositório fora do formato dono/repo')
  }
  return async (caminho) => {
    if (!caminho.startsWith('/') && caminho !== '') {
      throw new Error('caminho de leitura inválido')
    }
    if (caminho.includes('..')) throw new Error('caminho de leitura inválido')
    const resposta = await deps.fetchImpl(`${GITHUB_API}/repos/${deps.repositorio}${caminho}`, {
      headers: {
        Authorization: `Bearer ${deps.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'gitorch',
      },
    })
    avisarRespostaRuim(resposta, deps.aoReceberRespostaRuim)
    return lerRespostaDoGitHub(resposta, [deps.token])
  }
}
