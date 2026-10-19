// O pedido de ajuste parado num PR aberto pela conta do DONO do projeto.
//
// Quem abre PR pela conta do dono são, na prática, outros robôs dele, e o dono
// não olha PR. O revisor do produto pede mudanças, ninguém atende, e o PR fica
// parado para sempre. Em projeto `cuidar` o produto resolve: se ninguém mexer
// no PR por um tempo, ele passa o ajuste pedido para o dev automático, pela
// MESMA retomada que já existe para as entregas do próprio dev (parte da
// branch principal, cita o ramo antigo, respeita os tetos e a regra de
// substituição). Antes desse tempo o produto não toca, para não brigar com o
// robô que abriu o PR.
//
// Este arquivo só decide — puro, sem rede. Ler o GitHub e abrir a sessão é
// trabalho de `decisao-do-pedido-do-dono.ts` e do vigia.

import type { CausaDaParada } from './vigia-do-pr.js'

/** Quanto o PR do dono precisa ficar sem ninguém mexer, em horas, quando nada foi configurado. */
export const ESPERA_PADRAO_DO_DONO_HORAS = 24

/** Variável de ambiente que troca a espera (em horas). */
export const VARIAVEL_DA_ESPERA_DO_DONO = 'GITORCH_ESPERA_PEDIDO_DO_DONO_HORAS'

const UMA_HORA_MS = 60 * 60 * 1000

/** A espera configurada, em milissegundos; valor ausente, inválido ou não positivo cai no padrão. */
export function lerEsperaDoDonoMs(env: Record<string, string | undefined> = process.env): number {
  const bruto = Number(env[VARIAVEL_DA_ESPERA_DO_DONO])
  const horas = Number.isFinite(bruto) && bruto > 0 ? bruto : ESPERA_PADRAO_DO_DONO_HORAS
  return horas * UMA_HORA_MS
}

/** Rótulo que o dono (ou um robô dele) põe num PR para o produto não mexer nele. */
export const MARCA_NAO_MEXER = 'gitorch:nao-mexer'

export function temMarcaNaoMexer(labels: readonly string[] | null | undefined): boolean {
  return (labels ?? []).includes(MARCA_NAO_MEXER)
}

/**
 * Frase com que o aviso do revisor ao participante começa. O pedido que vai
 * para o dev automático corta o parecer aqui: o aviso fala com o autor do PR,
 * não com quem vai fazer o ajuste.
 */
export const ABERTURA_DO_AVISO_AO_PARTICIPANTE =
  'GitOrch analisou este PR porque você é participante do repositório'

/** A conta que abriu o PR é a do dono do projeto? Conta de robô nunca é. */
export function ehContaDoDono(
  autor: string | null | undefined,
  loginDoDono: string | null | undefined
): boolean {
  const a = (autor ?? '').trim().toLowerCase()
  const d = (loginDoDono ?? '').trim().toLowerCase()
  if (a === '' || d === '') return false
  if (a.endsWith('[bot]')) return false
  return a === d
}

/** O que, num comentário ou parecer, mostra que alguém mexeu — ou não. */
export interface InteracaoNoPr {
  /** Quando aconteceu (texto de data do GitHub). */
  quando: string | null | undefined
  login?: string | null | undefined
  /** `user.type` do GitHub; 'Bot' não é movimento. */
  tipo?: string | null | undefined
  corpo?: string | null | undefined
}

/** Toda marca que o produto escreve no PR começa assim. */
const COMECO_DE_MARCA_DO_PRODUTO = '<!-- gitorch:'

function ehMovimentoDeGente(i: InteracaoNoPr): boolean {
  if ((i.login ?? '').toLowerCase().endsWith('[bot]')) return false
  if (i.tipo === 'Bot') return false
  if ((i.corpo ?? '').includes(COMECO_DE_MARCA_DO_PRODUTO)) return false
  return true
}

/**
 * O último momento em que ALGUÉM mexeu no PR: o mais recente entre o último
 * commit e o último comentário ou parecer de quem não é o produto nem um
 * robô. O produto atualiza o PR ao revisar, então `updated_at` não serve —
 * olharia para o próprio revisor e o PR nunca pareceria parado.
 *
 * Sem a data do commit não há como provar a espera: devolve `null`.
 */
export function ultimoMovimentoReal(args: {
  ultimoCommitEm: Date | null
  interacoes: readonly InteracaoNoPr[]
}): Date | null {
  if (args.ultimoCommitEm === null) return null
  let ultimo = args.ultimoCommitEm.getTime()
  for (const i of args.interacoes) {
    if (!ehMovimentoDeGente(i)) continue
    const t = Date.parse(i.quando ?? '')
    if (Number.isFinite(t) && t > ultimo) ultimo = t
  }
  return new Date(ultimo)
}

export type RazaoDeNaoSerOCaso =
  | 'autor-nao-e-o-dono'
  | 'autonomia-nao-permite'
  | 'marcado-nao-mexer'
  | 'sem-motivo'
  | 'teto-de-retomadas'
  | 'movimento-desconhecido'

export type DecisaoDoPedidoDoDono =
  /** Passou a espera em projeto `cuidar`: passar o ajuste ao dev automático. */
  | { decisao: 'assume'; causa: CausaDaParada }
  /** Ainda cedo: não toca, e diz a partir de quando assume. */
  | { decisao: 'espera'; assumeEm: Date }
  /** Projeto `sugerir`, passada a espera: não assume, pergunta ao dono. */
  | { decisao: 'pergunta'; causa: CausaDaParada }
  | { decisao: 'nao-e-o-caso'; razao: RazaoDeNaoSerOCaso }

/**
 * O PR aberto pela conta do dono, parado, é para o produto assumir?
 *
 * `motivoParado` são os mesmos motivos que a retomada dos PRs do dev já trata:
 * o revisor pediu mudanças neste commit, a verificação está de fato vermelha,
 * ou há conflito com a branch principal. `retomadasFeitas` e `teto` são o
 * freio por PR que a retomada já usa.
 */
export function deveAssumirPedidoDoDono(args: {
  autonomia: string
  autorEhDono: boolean
  marcaNaoMexer: boolean
  ultimoMovimentoReal: Date | null
  agora: Date
  motivoParado: CausaDaParada | null
  retomadasFeitas: number
  teto: number
  /** Espera em milissegundos; sem ela vale a configurada (`lerEsperaDoDonoMs`). */
  esperaMs?: number
}): DecisaoDoPedidoDoDono {
  if (!args.autorEhDono) return { decisao: 'nao-e-o-caso', razao: 'autor-nao-e-o-dono' }
  if (args.autonomia !== 'cuidar' && args.autonomia !== 'sugerir') {
    return { decisao: 'nao-e-o-caso', razao: 'autonomia-nao-permite' }
  }
  if (args.marcaNaoMexer) return { decisao: 'nao-e-o-caso', razao: 'marcado-nao-mexer' }
  if (args.motivoParado === null) return { decisao: 'nao-e-o-caso', razao: 'sem-motivo' }
  if (args.retomadasFeitas >= args.teto) {
    return { decisao: 'nao-e-o-caso', razao: 'teto-de-retomadas' }
  }
  if (args.ultimoMovimentoReal === null) {
    return { decisao: 'nao-e-o-caso', razao: 'movimento-desconhecido' }
  }

  const esperaMs = args.esperaMs ?? lerEsperaDoDonoMs()
  const assumeEm = new Date(args.ultimoMovimentoReal.getTime() + esperaMs)
  const passouAEspera = args.agora.getTime() >= assumeEm.getTime()

  if (args.autonomia === 'sugerir') {
    // Sugerir nunca assume. Passada a espera, só vale perguntar; antes disso o
    // robô que abriu o PR ainda pode estar trabalhando.
    return passouAEspera
      ? { decisao: 'pergunta', causa: args.motivoParado }
      : { decisao: 'nao-e-o-caso', razao: 'autonomia-nao-permite' }
  }
  return passouAEspera
    ? { decisao: 'assume', causa: args.motivoParado }
    : { decisao: 'espera', assumeEm }
}
