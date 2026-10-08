// A leitura do quadro (Projects v2) compartilhada entre quem precisa dela no
// mesmo intervalo: a conferência das tarefas (varredura do retrato) e a conta
// do custo da ordem leem o MESMO quadro, ambos de 30 em 30 minutos. Sem isto,
// cada um paga as páginas dos itens (e a leitura da sprint) por conta própria.
//
// Em memória de propósito: zera a cada reinício e o pior efeito é uma leitura
// a mais, que já seria feita hoje. A chave é o id do quadro (nunca o projeto):
// dois jeitos diferentes de achar o quadro que cheguem ao mesmo id dividem a
// mesma leitura; ids diferentes nunca se misturam. Falha não fica guardada.

import type { ProjectV2Client } from '@gitorch/github-sync'
import { hojeNoFuso, sprintCorrente, type Iteracao } from './garantir-sprint.js'

/** Um item do quadro como o `ProjectV2Client` o devolve (o tipo não é exportado pelo pacote). */
export type ItemDoQuadro = Awaited<ReturnType<ProjectV2Client['listarItensDoQuadro']>>[number]

/** Quanto tempo uma leitura serve a quem pedir depois (abaixo dos 30 min de cadência). */
export const JANELA_DO_CACHE_DO_QUADRO_MS = 25 * 60_000

export interface LeituraDoQuadro {
  itens: ItemDoQuadro[]
  /** O teto de páginas cortou a lista: quem não aparece pode estar no quadro. */
  truncado: boolean
  /**
   * A iteração (sprint) que corre hoje. `null` = não se sabe: o quadro não tem
   * o campo Sprint, o nome está ocupado por outro tipo de campo, ou nenhuma
   * sprint cobre o dia de hoje.
   */
  iteracaoCorrenteId: string | null
}

/** O que a leitura completa pede do cliente do quadro (o `ProjectV2Client` serve). */
export interface ClienteParaLerOQuadro {
  listarItensDoQuadro: (
    projectId: string,
    opcoes?: {
      campoDeSprint?: string
      campoDePeso?: string
      comCorpo?: boolean
      onTruncado?: (lidos: number) => void
    }
  ) => Promise<ItemDoQuadro[]>
  getIterationField: (input: {
    projectId: string
    fieldName: string
  }) => Promise<{ fieldId: string; iterations: Iteracao[] }>
}

/** Falhas que só dizem "este quadro não tem sprint utilizável" — nunca rede, permissão ou cota. */
const ERROS_DE_CAMPO_DE_SPRINT = new Set([
  'CampoDeIteracaoAusenteError',
  'NomeDeCampoEmConflitoError',
])

/**
 * Lê o quadro inteiro de uma vez: itens com sprint, peso e corpo, mais a
 * iteração que corre hoje. É a leitura que serve aos dois consumidores.
 */
export async function lerQuadroCompleto(
  cliente: ClienteParaLerOQuadro,
  quadroId: string,
  hoje: string = hojeNoFuso()
): Promise<LeituraDoQuadro> {
  let truncado = false
  const itens = await cliente.listarItensDoQuadro(quadroId, {
    campoDeSprint: 'Sprint',
    campoDePeso: 'Peso',
    comCorpo: true,
    onTruncado: () => {
      truncado = true
    },
  })

  let iteracaoCorrenteId: string | null = null
  try {
    const campo = await cliente.getIterationField({ projectId: quadroId, fieldName: 'Sprint' })
    iteracaoCorrenteId = sprintCorrente(campo.iterations, hoje)?.id ?? null
  } catch (erro) {
    // Só a ausência do campo é tolerada; o resto sobe para quem chamou decidir.
    if (!(erro instanceof Error && ERROS_DE_CAMPO_DE_SPRINT.has(erro.name))) throw erro
  }
  return { itens, truncado, iteracaoCorrenteId }
}

interface EntradaDoCache {
  leitura: Promise<LeituraDoQuadro>
  lidoEm: number
}

const entradas = new Map<string, EntradaDoCache>()

/**
 * Devolve a leitura guardada do quadro se ainda estiver na janela; senão chama
 * `carregar`. Leituras simultâneas dividem a mesma ida ao GitHub. Falha apaga
 * a entrada: a próxima tentativa lê de novo.
 */
export function lerQuadroComCache(
  quadroId: string,
  carregar: () => Promise<LeituraDoQuadro>,
  agora: () => Date = () => new Date()
): Promise<LeituraDoQuadro> {
  const instante = agora().getTime()
  const guardada = entradas.get(quadroId)
  if (guardada && instante - guardada.lidoEm <= JANELA_DO_CACHE_DO_QUADRO_MS) {
    return guardada.leitura
  }
  const leitura = carregar()
  const entrada: EntradaDoCache = { leitura, lidoEm: instante }
  entradas.set(quadroId, entrada)
  leitura.catch(() => {
    if (entradas.get(quadroId) === entrada) entradas.delete(quadroId)
  })
  return leitura
}

/** Esquece a leitura de um quadro (a ordem mudou, por exemplo). */
export function esquecerLeituraDoQuadro(quadroId: string): void {
  entradas.delete(quadroId)
}

/** Só para teste: esquece todas as leituras. */
export function limparCacheDeLeituraDoQuadro(): void {
  entradas.clear()
}
