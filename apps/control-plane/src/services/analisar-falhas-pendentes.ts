// Orquestra a análise das issues que falharam 2× (D51). Roda junto do RA na
// agenda (o RA já é o "explorador" que alimenta a memória dos agentes). Tudo
// por injeção — testável sem rede, sem banco, sem motor.

import type { AnaliseDeFalha, EntradaDaAnalise } from './analise-de-falha-do-dev.js'

/** Quantas issues analisar por passada — a análise gasta motor. */
export const TETO_DE_ANALISES_POR_PASSADA = 2

export interface AnalisarFalhasDeps {
  /** Issues do projeto com análise pendente (`issuesComAnalisePendente`). */
  listarPendentes: () => Promise<number[]>
  /** Reúne o que a análise precisa: corpo da issue, sessões mortas, comentários de QA. */
  dadosDaIssue: (issueNumber: number) => Promise<EntradaDaAnalise | null>
  /** Roda a análise no motor (`runAnaliseDeFalha`). */
  analisar: (entrada: EntradaDaAnalise) => Promise<AnaliseDeFalha>
  /** Grava o aprendizado na memória dos agentes (`registrarAprendizado`). */
  gravarAprendizado: (args: { issueNumber: number; analise: AnaliseDeFalha }) => Promise<void>
  /** Marca a análise como feita para a issue (`marcarAnaliseFeitaDaIssue`). */
  marcarFeita: (issueNumber: number) => Promise<void>
  teto?: number
  onInfo?: (m: string) => void
  onWarn?: (m: string) => void
}

export interface AnalisarFalhasResultado {
  analisadas: number[]
  /** Padrões descobertos, para o chamador consolidar num aviso ao dono. */
  padroes: Array<{ issueNumber: number; padrao: string }>
}

export async function analisarFalhasPendentes(
  deps: AnalisarFalhasDeps
): Promise<AnalisarFalhasResultado> {
  const info = deps.onInfo ?? (() => undefined)
  const warn = deps.onWarn ?? (() => undefined)
  const teto = deps.teto ?? TETO_DE_ANALISES_POR_PASSADA

  const r: AnalisarFalhasResultado = { analisadas: [], padroes: [] }
  const pendentes = (await deps.listarPendentes()).slice(0, teto)

  for (const issueNumber of pendentes) {
    try {
      const entrada = await deps.dadosDaIssue(issueNumber)
      if (!entrada || entrada.sessoesMortas.length < 2) {
        // Ainda não são 2 falhas de verdade — não força a análise.
        warn(`[analise-falhas] #${issueNumber}: menos de 2 sessões mortas legíveis; pula`)
        continue
      }
      const analise = await deps.analisar(entrada)
      await deps.gravarAprendizado({ issueNumber, analise })
      await deps.marcarFeita(issueNumber)
      r.analisadas.push(issueNumber)
      r.padroes.push({ issueNumber, padrao: analise.padraoDoJules })
      info(
        `[analise-falhas] #${issueNumber}: entendida — "${analise.causaComum}". ` +
          'A 3ª tentativa vai com o pedido revisado.'
      )
    } catch (err) {
      // Uma que falha não trava as outras nem a issue: se a análise não
      // conclui, a issue continua marcada como pendente e volta na próxima
      // passada. Nunca fica presa.
      warn(
        `[analise-falhas] #${issueNumber} não pôde ser analisada agora: ${(err as Error).message}`
      )
    }
  }

  return r
}
