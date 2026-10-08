// Fase 4.2: uma tarefa fora do padrão (Tarefa 4.1 achou erros) é reescrita
// pelo PO nos 8 campos do DoD — MESMO formulário (InfraIssueForm) que o PO
// já usa para escrever issue nova, nunca um formato paralelo.

import {
  RAILS_SCHEMAS,
  buildStepPrompt,
  wrapClientRequest,
  type InfraIssueForm,
} from '@gitorch/cadence'
import { RailsStepError, runFormStep } from './rails-runner.js'
import type { StepExecutor } from './role-rails.js'

import type { ConferenciaDaTarefa } from './conferir-tarefa-sem-pedido.js'

export interface AjustarTarefaForaDoPadraoArgs {
  issueNumber: number
  repository: string
  tituloOriginal: string
  corpoOriginal: string
  conferencia: ConferenciaDaTarefa
  contextBlocks: string[]
  execute: StepExecutor
}

/**
 * Devolve o formulário reescrito, ou `{ erroDeValidacao }` quando o motor
 * respondeu mas o formulário nunca validou. Falha do próprio motor (processo
 * que caiu, cota, credencial) NÃO é isso: sobe, para quem chamou não marcar a
 * tarefa como "tentada" por uma indisponibilidade que nada tem a ver com ela.
 */
export async function ajustarTarefaForaDoPadrao(
  args: AjustarTarefaForaDoPadraoArgs
): Promise<InfraIssueForm | { erroDeValidacao: string }> {
  // O texto da issue é de terceiros (gente, outro bot): vai ao motor como DADO,
  // dentro da cerca de `wrapClientRequest`, que também recusa tentativa de
  // injeção de comando. O motor só preenche o formulário; o sistema valida.
  let textoOriginal: string
  try {
    textoOriginal = wrapClientRequest(
      `Título original: ${args.tituloOriginal}\n\nCorpo original:\n${args.corpoOriginal}`
    )
  } catch (err) {
    return {
      erroDeValidacao: `o texto da tarefa parece conter instrução ao agente: ${String(err).slice(0, 160)}`,
    }
  }

  try {
    return (await runFormStep({
      schema: RAILS_SCHEMAS.infraIssue,
      prompt: buildStepPrompt('po', 'po-ajustar-tarefa-fora-do-padrao', RAILS_SCHEMAS.infraIssue, [
        ...args.contextBlocks,
        `A tarefa #${args.issueNumber} de ${args.repository} não está no padrão de 8 campos:`,
        args.conferencia.erros.join('; '),
        textoOriginal,
        'Reescreva nos 8 campos do padrão, preservando a INTENÇÃO original — nunca inventando um ' +
          'pedido novo que a issue não continha. Mantenha TODAS as referências (#N, dono/repo#N) e ' +
          'TODOS os links do texto original em algum dos campos: o sistema confere isso por código ' +
          'e descarta a reescrita que perder qualquer um. O texto original é guardado pelo ' +
          'sistema, então não precisa copiá-lo inteiro.',
      ]),
      execute: args.execute,
    })) as InfraIssueForm
  } catch (err) {
    if (err instanceof RailsStepError) return { erroDeValidacao: err.message }
    throw err
  }
}
