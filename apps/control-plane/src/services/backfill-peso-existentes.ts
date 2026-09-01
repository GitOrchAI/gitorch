import type { PesoDeTask } from '@gitorch/cadence'
import { pesoDoCorpoDaIssue } from './backlog-executor.js'

// D8 — "PREENCHA O QUE JÁ ESTÁ LÁ". O mecanismo de `setWeight`
// (github-backlog.ts, PR #417) só grava o campo "Peso" para issue NOVA;
// os itens que já existiam no quadro quando ele nasceu ficam mudos por
// tempo indeterminado — foi exatamente o que aconteceu com o campo Sprint
// (PR #416): mecanismo no ar, quadro do dono com 3 de 124 preenchidos.
//
// Esta passada varre o quadro UMA vez: item que já tem peso no campo não é
// tocado (idempotente — rodar de novo não sobrescreve nada); item sem peso
// no campo tem o corpo da issue consultado (`pesoDoCorpoDaIssue`) — se o
// texto tem "## Peso" com um valor da ESCALA_DE_PESO, o campo é preenchido
// com ELE, nunca um número inventado; se não tem (fase/épico/feature —
// nunca carregam peso por desenho — ou issue anterior ao PR #417), o item
// fica sem peso e é CONTADO, nunca chutado.

/** Um item do quadro, do jeito mínimo que o backfill precisa dele. */
export interface ItemParaBackfillDePeso {
  itemId: string
  issueNumber: number
  /** O que já está no campo "Peso" do card. `null` = ainda não preenchido. */
  pesoAtual: number | null
  /** O corpo (markdown) da issue, para achar o peso que só está no TEXTO. */
  corpo: string | null
}

export interface DepsDoBackfillDePeso {
  /** Todos os itens do quadro, já com pesoAtual e corpo lidos. */
  listarItens(): Promise<ItemParaBackfillDePeso[]>
  /** Grava o peso no campo "Peso" do card. */
  gravarPeso(itemId: string, peso: PesoDeTask): Promise<void>
}

export interface ResultadoDoBackfillDePeso {
  totalItens: number
  /** Já tinha peso no campo antes desta passada — não tocado. */
  jaTinhaPeso: number
  /** Peso achado no corpo e gravado no campo nesta passada. */
  preenchidosAgora: number
  /** Sem peso no campo E sem "## Peso" (ou fora da escala) no corpo. */
  semPesoNoCorpo: number
  /** Números das issues que ficaram sem peso — para o relato dizer QUAIS. */
  issuesSemPeso: number[]
}

export async function backfillPesoDosItensExistentes(
  deps: DepsDoBackfillDePeso
): Promise<ResultadoDoBackfillDePeso> {
  const itens = await deps.listarItens()

  let jaTinhaPeso = 0
  let preenchidosAgora = 0
  const issuesSemPeso: number[] = []

  // EM SÉRIE, de propósito: é uma passada de manutenção sobre o quadro REAL
  // do cliente, não um cálculo local — uma escrita simultânea por item
  // arriscaria a mesma corrida que o resto do produto evita (fetchComTeto).
  // Uma falha de rede no meio SOBE crua: mascarar aqui deixaria o quadro
  // pela metade sem ninguém saber quais itens ficaram para trás.
  for (const item of itens) {
    if (item.pesoAtual !== null) {
      jaTinhaPeso += 1
      continue
    }
    const peso = pesoDoCorpoDaIssue(item.corpo)
    if (peso === null) {
      issuesSemPeso.push(item.issueNumber)
      continue
    }
    await deps.gravarPeso(item.itemId, peso)
    preenchidosAgora += 1
  }

  return {
    totalItens: itens.length,
    jaTinhaPeso,
    preenchidosAgora,
    semPesoNoCorpo: issuesSemPeso.length,
    issuesSemPeso,
  }
}
