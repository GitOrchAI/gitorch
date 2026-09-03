// C10 (fix-up L4-T5, CSO) — caso legado ACEITO como referência: "#3907
// fechado como substituído por #3917" (issue #3884 do Jardim, 5 sessões e 3
// pull requests para uma task). Mesmo com a fila (fila-de-delegacao.ts), a
// retomada no mesmo PR (retomar-pr-reprovado.ts) e o fecho automático do
// antigo QUANDO UM NOVO NASCE (pr-substituido.ts) já corrigidos, um par de
// PRs duplicados que já existia ANTES desses três consertos fica órfão para
// sempre — nenhum dos três olha para trás. Esta é a REDE DE SEGURANÇA:
// varredura periódica que, por projeto, agrupa os PRs abertos do dev por
// issue e fecha todos menos o mais novo — mesma decisão pura
// (`deveFecharComoSubstituido`) e mesmo marcador (`marcadorDePrSubstituido`)
// de `pr-substituido.ts`, nunca uma segunda cópia da regra.
//
// PURO NA DECISÃO — sem rede — e a ação (ler o PR, os comentários,
// comentar+fechar) é injetada, mesma disciplina de `pr-substituido.ts`.

import {
  deveFecharComoSubstituido,
  marcadorDePrSubstituido,
  type SinaisDoPrAntigo,
} from './pr-substituido.js'

export interface DepsDeVarreduraDePrsDuplicados {
  /**
   * Por issue: todos os números de PR que `dev_sessions` já registrou para
   * ela (vivos ou fechados) — a mesma fonte de `fecharPrsSubstituidosDaEntrega`
   * (github-webhook.ts). Repetidos e PRs já fechados/mesclados são filtrados
   * aqui dentro (via `lerPr`); o chamador não precisa fazer essa triagem.
   */
  issuesComPrsRegistrados: () => Promise<Map<number, number[]>>
  /** O que basta saber de CADA PR para decidir — `null` quando não deu para ler. */
  lerPr: (numeroDoPr: number) => Promise<SinaisDoPrAntigo | null>
  /** Comentários JÁ existentes no PR — só para a idempotência. */
  comentariosDoPr: (numeroDoPr: number) => Promise<string[]>
  comentarEFechar: (args: { numeroDoPr: number; comentario: string }) => Promise<void>
  onInfo?: (m: string) => void
  onWarn?: (m: string) => void
}

export interface ResultadoDaVarreduraDePrsDuplicados {
  /** Quantas issues tinham 2+ PRs do dev ABERTOS ao mesmo tempo. */
  issuesComDuplicata: number
  /** Quantos PRs antigos foram fechados. */
  fechados: number
  /** Quantas tentativas de fechar falharam (nunca contaminam as outras). */
  falhas: number
}

/** O comentário PT-BR deixado no PR antigo antes de fechá-lo. */
function comentarioDeDuplicataLegada(numeroDoNovoPr: number): string {
  return (
    `Substituído por #${numeroDoNovoPr}.\n\n` +
    'Esta tarefa acumulou mais de um pull request aberto do dev assíncrono ao mesmo tempo; ' +
    'fechando esta entrega para não deixar duas disputando a mesma issue.\n\n' +
    marcadorDePrSubstituido(numeroDoNovoPr)
  )
}

/**
 * Varre TODAS as issues do projeto que já tiveram mais de um pull request do
 * dev registrado e fecha os que ainda estão abertos, menos o mais novo (o
 * NÚMERO mais alto — no GitHub o número de PR só cresce, então é sempre o
 * mais recente).
 */
export async function varrerPrsDuplicadosDoDev(
  deps: DepsDeVarreduraDePrsDuplicados
): Promise<ResultadoDaVarreduraDePrsDuplicados> {
  const info = deps.onInfo ?? (() => undefined)
  const warn = deps.onWarn ?? (() => undefined)

  const mapa = await deps.issuesComPrsRegistrados()

  let issuesComDuplicata = 0
  let fechados = 0
  let falhas = 0

  for (const [issueNumber, prNumbersBrutos] of mapa) {
    const prNumbers = [...new Set(prNumbersBrutos)]
    if (prNumbers.length < 2) continue

    // Lê cada PR desta issue uma vez só (cacheado) — nunca duas chamadas ao
    // mesmo número, mesmo que ele apareça na varredura de outra issue por
    // engano de dados.
    const sinaisPorPr = new Map<number, SinaisDoPrAntigo | null>()
    for (const numeroDoPr of prNumbers) {
      try {
        sinaisPorPr.set(numeroDoPr, await deps.lerPr(numeroDoPr))
      } catch (err) {
        sinaisPorPr.set(numeroDoPr, null)
        warn(
          `[prs-duplicados] não deu para ler #${numeroDoPr} (issue #${issueNumber}): ` +
            `${(err as Error).message}`
        )
      }
    }

    // Só os que estão de fato ABERTOS agora e são do dev — o mesmo filtro de
    // `pr-substituido.ts`, aplicado a cada candidato do grupo.
    const abertosDoDev = prNumbers.filter((n) =>
      deveFecharComoSubstituido(sinaisPorPr.get(n) ?? null)
    )
    if (abertosDoDev.length < 2) continue

    issuesComDuplicata += 1
    const maisNovo = Math.max(...abertosDoDev)
    const antigos = abertosDoDev.filter((n) => n !== maisNovo)

    for (const numeroDoPr of antigos) {
      try {
        const comentarios = await deps.comentariosDoPr(numeroDoPr)
        const marcador = marcadorDePrSubstituido(maisNovo)
        if (comentarios.some((c) => c.includes(marcador))) continue

        await deps.comentarEFechar({
          numeroDoPr,
          comentario: comentarioDeDuplicataLegada(maisNovo),
        })
        fechados += 1
        info(
          `[prs-duplicados] #${numeroDoPr} (issue #${issueNumber}) fechado — substituído por #${maisNovo}`
        )
      } catch (err) {
        falhas += 1
        warn(
          `[prs-duplicados] não deu para fechar #${numeroDoPr} (issue #${issueNumber}): ` +
            `${(err as Error).message}`
        )
      }
    }
  }

  return { issuesComDuplicata, fechados, falhas }
}
