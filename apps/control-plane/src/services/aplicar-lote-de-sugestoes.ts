// D7 (parte A) — a ÚNICA parte deste recurso que escreve no GitHub. Recebe a
// decisão já resolvida por `resolverAvalDoLote` (lote-de-sugestoes.ts) e
// aplica: fecha issue, ou fecha como duplicata, comentando o motivo. Item
// recusado ou sem ação de escrita ('sinalizar') nunca chama `fecharIssue`.
//
// A GUARDA DE AUTONOMIA usa a MESMA classificação que a rede de verdade usa —
// não uma tabela paralela. `classificarRequisicao` (guarda-de-autonomia.ts)
// já resolve `PATCH /issues/:n` (fechar) e `POST /issues/:n/comments`
// (comentar) como família 'propor': "abrir e mexer em pedido, e falar no
// pedido". Checar aqui com QUALQUER outra família (ex.: 'organizar') correria
// o risco de este serviço liberar uma escrita que a porta de rede
// (`fetchDoRepositorio`) recusaria na hora H — ou o inverso. 'propor' está
// liberado desde o nível "sugerir" (o padrão do desenho: "organizo o quadro e
// proponho trabalho, mas não mesclo nada"), e "só olhar" continua recusando
// SEMPRE, mesmo com aprovação do dono — "mostra e para" é a regra, e a guarda
// é quem garante isso, não uma checagem de nível reimplementada aqui.
import { podeEscrever, type NivelDeAutonomia } from '@gitorch/cadence'
import type { AcaoDeLote, CategoriaDeDiagnostico, ItemComDecisao } from './lote-de-sugestoes.js'

export interface ResultadoDoItemAplicado extends ItemComDecisao {
  aplicado: boolean
  /** Por que aplicou, ou por que não — nunca fica em branco. */
  motivoDoResultado: string
}

export interface DependenciasDoAplicarLote {
  nivel: NivelDeAutonomia | null | undefined | string
  /** A MESMA forma de `fecharIssue` já usada em scheduler.ts (fechar-incidente-resolvido):
   *  PATCH state:closed + comentário. Quem monta a chamada real é quem injeta isto. */
  fecharIssue: (issueNumber: number, comentario: string) => Promise<void>
}

function montarComentario(item: Pick<ItemComDecisao, 'acao' | 'motivo' | 'duplicadaDe'>): string {
  const assinatura =
    'Isto foi feito pelo GitOrch (nível "Sugerir"), com o seu aval em lote — não é uma ação automática.'
  if (item.acao === 'juntar') {
    const original =
      item.duplicadaDe !== undefined ? ` da issue #${item.duplicadaDe}` : ' de outra issue'
    return `Fechada como duplicata${original}.\n\nMotivo: ${item.motivo}\n\n${assinatura}`
  }
  // acao === 'fechar' (o único outro caso com escrita — 'sinalizar' nunca chega aqui)
  return `Fechada.\n\nMotivo: ${item.motivo}\n\n${assinatura}`
}

/**
 * NUNCA lança: cada item vira um resultado, aplicado ou não, com o motivo —
 * a mesma garantia de degradação graciosa do resto do produto (um item com
 * problema nunca derruba o lote inteiro).
 */
export async function aplicarLoteDeSugestoes(
  itens: ItemComDecisao[],
  deps: DependenciasDoAplicarLote
): Promise<ResultadoDoItemAplicado[]> {
  const resultados: ResultadoDoItemAplicado[] = []

  for (const item of itens) {
    if (item.decisao === 'recusado') {
      resultados.push({ ...item, aplicado: false, motivoDoResultado: 'recusado pelo dono' })
      continue
    }

    if (item.acao === 'sinalizar') {
      resultados.push({
        ...item,
        aplicado: false,
        motivoDoResultado:
          'categoria sem ação de escrita — só sinaliza para o dono ler, nada a aplicar',
      })
      continue
    }

    const decisaoDeAutonomia = podeEscrever(deps.nivel, 'propor')
    if (!decisaoDeAutonomia.pode) {
      resultados.push({ ...item, aplicado: false, motivoDoResultado: decisaoDeAutonomia.motivo })
      continue
    }

    try {
      await deps.fecharIssue(item.issue, montarComentario(item))
      resultados.push({ ...item, aplicado: true, motivoDoResultado: 'aplicado' })
    } catch (err) {
      resultados.push({
        ...item,
        aplicado: false,
        motivoDoResultado: `falhou ao aplicar: ${(err as Error).message}`,
      })
    }
  }

  return resultados
}

export type { AcaoDeLote, CategoriaDeDiagnostico, ItemComDecisao }
