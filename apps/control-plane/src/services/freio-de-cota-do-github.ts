// Freio compartilhado da cota do GitHub, por dono da instalação.
//
// Medido em produção: mais de mil respostas 403 em 6,7 h, quase todas de
// etapas do tique que repetiam a mesma leitura (`GET /issues/N`) a cada
// passada, sem ninguém parar depois do primeiro "não". Aqui, a primeira
// resposta que prova limite de taxa (403/429 com `retry-after`, ou com a
// cota zerada e a hora do reset) marca o dono como "em freio" até o reset,
// no máximo por 15 minutos; as etapas consultam `freioDeCotaAtivo` e PULAM a
// passada — com uma linha de log, nunca em silêncio.
//
// Em memória de propósito: zera a cada reinício, e o pior efeito disso é uma
// chamada a mais que já seria feita hoje. Um 403 de permissão (cota sobrando,
// sem `retry-after`) não freia ninguém: o freio só reage a limite de taxa.

import {
  ErroDoGitHub,
  erroDaRespostaDoGitHub,
  type RespostaComCabecalhos,
} from './erro-do-github.js'

export const TETO_DO_FREIO_DE_COTA_MS = 15 * 60_000

const freiosAte = new Map<string, number>()

/** O dono (instalação) de um repositório `dono/repo`, em minúsculas. */
export function donoDoRepositorio(repositorio: string): string {
  return (repositorio.split('/')[0] ?? '').toLowerCase()
}

/** O dono de um caminho da API (`/repos/dono/repo/...`), ou `null` sem repositório. */
export function donoDoCaminho(caminho: string): string | null {
  const achou = /^\/repos\/([^/]+)\//.exec(caminho)
  return achou?.[1] ? achou[1].toLowerCase() : null
}

/**
 * Registra o freio se o erro prova limite de taxa. Devolve até quando o dono
 * ficou em freio, ou `null` quando o erro não é de cota (nada muda).
 */
export function registrarFreioDeCota(owner: string, erro: unknown, agora: Date): Date | null {
  if (!(erro instanceof ErroDoGitHub)) return null
  if (erro.status !== 403 && erro.status !== 429) return null

  const candidatos: number[] = []
  if (erro.retryAfterSegundos !== null && erro.retryAfterSegundos > 0) {
    candidatos.push(agora.getTime() + erro.retryAfterSegundos * 1000)
  }
  if (erro.limiteRestante === 0 && erro.limiteResetaEmSegundos !== null) {
    candidatos.push(erro.limiteResetaEmSegundos * 1000)
  }
  const pedido = candidatos.length > 0 ? Math.max(...candidatos) : null
  if (pedido === null || pedido <= agora.getTime()) return null

  const ate = Math.min(pedido, agora.getTime() + TETO_DO_FREIO_DE_COTA_MS)
  const chave = owner.toLowerCase()
  const anterior = freiosAte.get(chave)
  const final = anterior !== undefined && anterior > ate ? anterior : ate
  freiosAte.set(chave, final)
  return new Date(final)
}

/** Até quando o dono está em freio, ou `null` se não está (agora). */
export function freioDeCotaAte(owner: string, agora: Date): Date | null {
  const chave = owner.toLowerCase()
  const ate = freiosAte.get(chave)
  if (ate === undefined) return null
  if (ate <= agora.getTime()) {
    freiosAte.delete(chave)
    return null
  }
  return new Date(ate)
}

export function freioDeCotaAtivo(owner: string, agora: Date): boolean {
  return freioDeCotaAte(owner, agora) !== null
}

/** Só para teste: esquece todos os freios. */
export function limparFreiosDeCota(): void {
  freiosAte.clear()
}

/**
 * Monta o erro tipado de uma resposta ruim, registra o freio do dono do
 * caminho (se for limite de taxa) e lança. O ponto único que `ghGet`,
 * `ghSend` e as chamadas REST das etapas do tique usam.
 */
export function lancarErroDoGitHub(
  mensagem: string,
  resposta: RespostaComCabecalhos,
  caminho: string,
  agora: Date = new Date()
): never {
  const erro = erroDaRespostaDoGitHub(mensagem, resposta)
  const dono = donoDoCaminho(caminho)
  if (dono !== null) registrarFreioDeCota(dono, erro, agora)
  throw erro
}

/**
 * Para as etapas do tique: devolve `true` (e a etapa pula este repositório)
 * quando o dono está em freio. Escreve UMA linha de log por dono por passada
 * — `jaAvisados` é do chamador e vive só durante a passada.
 */
export function pularSeFreioDeCotaAtivo(args: {
  etapa: string
  repositorio: string
  agora: Date
  jaAvisados: Set<string>
  info: (mensagem: string) => void
}): boolean {
  const dono = donoDoRepositorio(args.repositorio)
  const ate = freioDeCotaAte(dono, args.agora)
  if (ate === null) return false
  if (!args.jaAvisados.has(dono)) {
    args.jaAvisados.add(dono)
    args.info(
      `${args.etapa}: GitHub em freio de cota para "${dono}" até ${ate.toISOString()}; pulando esta passada`
    )
  }
  return true
}
