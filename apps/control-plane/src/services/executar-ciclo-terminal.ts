// A varredura que FECHA a sessão que o Jules já terminou — e devolve a issue
// para a fila (D51: nunca abandona de vez).
//
// Irmã de `devolverVagasDeSessaoAbandonada` (scheduler) / `sessoesAbandonadas`
// (sessao-abandonada.ts): aquela trata a sessão que ficou PARADA sem terminar;
// esta trata a que TERMINOU (COMPLETED/FAILED) e cuja linha nunca fechou. Foi a
// falta desta que encheu as 15 vagas do gitorch e parou a esteira em 29/08.
//
// Tudo por injeção — sem prisma, fetch ou env aqui. Quem decide a AÇÃO é
// `decidirSessaoTerminal` (pura); quem EXECUTA é este módulo, por injeção; quem
// liga nos deps reais é o scheduler.

import { ehTerminal } from './estados-de-sessao.js'
import {
  decidirSessaoTerminal,
  HORAS_ATE_DESISTIR_DO_PR_REJEITADO,
  type SituacaoDoPr,
} from './sessao-terminal.js'
import type { LinhaParaCicloTerminal } from './dev-session-store.js'
import type { MotivoDeFechamento } from './dev-session-store.js'

/** Teto por varredura — um acúmulo não fecha tudo de uma vez sem ninguém ver. */
export const TETO_POR_VARREDURA_TERMINAL = 25

export interface CicloTerminalDeps {
  /** Todas as linhas vivas da instância (`linhasVivasParaCicloTerminal`). */
  listarLinhas: () => Promise<LinhaParaCicloTerminal[]>
  /**
   * Lê a situação do PR da sessão. Recebe o número do PR (ou null) e há quantas
   * horas a sessão está terminal — para o chamador decidir "aberto-vivo" vs.
   * "aberto-rejeitado-parado". Devolve null quando não deu para ler (a linha
   * fica para o próximo ciclo).
   */
  situacaoDoPr: (args: {
    linha: LinhaParaCicloTerminal
    numeroDoPr: number | null
    horasNoTerminal: number
  }) => Promise<SituacaoDoPr | null>
  fecharSessao: (args: {
    linha: LinhaParaCicloTerminal
    motivo: MotivoDeFechamento
  }) => Promise<void>
  /** 2ª falha na mesma issue: pede a análise de "por que" antes da 3ª tentativa. */
  pedirAnalise: (args: { linha: LinhaParaCicloTerminal }) => Promise<void>
  agora: Date
  teto?: number
  onInfo?: (m: string) => void
  onWarn?: (m: string) => void
}

export interface CicloTerminalResultado {
  fechadasConcluidas: number
  /** Issues que voltaram para a fila (o chamador consolida num aviso só). */
  issuesRedelegadas: number[]
  /** Issues cuja 2ª falha pediu análise antes da 3ª tentativa. */
  issuesEmAnalise: number[]
  mantidas: number
  ilegiveis: number
}

function horasEntre(agora: Date, quando: Date | null): number {
  if (!quando) return Number.POSITIVE_INFINITY
  return (agora.getTime() - quando.getTime()) / (60 * 60 * 1000)
}

export async function executarCicloTerminal(
  deps: CicloTerminalDeps
): Promise<CicloTerminalResultado> {
  const info = deps.onInfo ?? (() => undefined)
  const warn = deps.onWarn ?? (() => undefined)
  const teto = deps.teto ?? TETO_POR_VARREDURA_TERMINAL

  const r: CicloTerminalResultado = {
    fechadasConcluidas: 0,
    issuesRedelegadas: [],
    issuesEmAnalise: [],
    mantidas: 0,
    ilegiveis: 0,
  }

  const linhas = (await deps.listarLinhas()).filter((l) => ehTerminal(l.state))
  // Mais paradas primeiro: fechar as mais antigas devolve as vagas mais seguras.
  linhas.sort(
    (a, b) => horasEntre(deps.agora, b.lastProgressAt) - horasEntre(deps.agora, a.lastProgressAt)
  )

  let feitas = 0
  for (const linha of linhas) {
    if (feitas >= teto) break

    const horasNoTerminal = horasEntre(deps.agora, linha.lastProgressAt)

    let situacao: SituacaoDoPr | null
    try {
      situacao = await deps.situacaoDoPr({
        linha,
        numeroDoPr: linha.pullRequestNumber,
        horasNoTerminal,
      })
    } catch (err) {
      warn(
        `[ciclo-terminal] não deu para ler o PR de ${linha.sessionName}: ${(err as Error).message}`
      )
      situacao = null
    }
    if (situacao === null) {
      r.ilegiveis += 1
      continue
    }

    const decisao = decidirSessaoTerminal({
      estado: linha.state,
      situacaoDoPr: situacao,
      requeueCount: linha.requeueCount,
      analiseJaFeita: linha.analysisDoneAt !== null,
      horasNoTerminal,
    })

    if (decisao.acao === 'manter') {
      r.mantidas += 1
      continue
    }

    try {
      await deps.fecharSessao({ linha, motivo: decisao.motivo })
      feitas += 1
    } catch (err) {
      warn(`[ciclo-terminal] não deu para fechar ${linha.sessionName}: ${(err as Error).message}`)
      continue
    }

    if (decisao.acao === 'fechar-concluido') {
      r.fechadasConcluidas += 1
      info(
        `[ciclo-terminal] ${linha.sessionName} (issue #${linha.issueNumber}) mesclada — linha fechada`
      )
      continue
    }

    // fechar-e-redelegar | fechar-e-analisar: a issue volta para a fila. O aviso
    // ao dono é CONSOLIDADO pelo chamador (um por varredura), nunca um por
    // sessão — o dono já reclamou de spam no Telegram.
    if (decisao.acao === 'fechar-e-analisar') {
      r.issuesEmAnalise.push(linha.issueNumber)
      await deps
        .pedirAnalise({ linha })
        .catch((err) =>
          warn(
            `[ciclo-terminal] pedido de análise falhou para #${linha.issueNumber}: ${(err as Error).message}`
          )
        )
      info(
        `[ciclo-terminal] ${linha.sessionName} (issue #${linha.issueNumber}) fechada (${decisao.motivo}); ` +
          '2ª falha — análise pedida antes da 3ª tentativa'
      )
    } else {
      r.issuesRedelegadas.push(linha.issueNumber)
      info(
        `[ciclo-terminal] ${linha.sessionName} (issue #${linha.issueNumber}) fechada (${decisao.motivo}); ` +
          'a issue volta para a fila'
      )
    }
  }

  return r
}

// Re-export para o scheduler não precisar importar de dois lugares.
export { HORAS_ATE_DESISTIR_DO_PR_REJEITADO }
