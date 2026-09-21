// Fase 4.2: uma tarefa fora do padrão (Tarefa 4.1 achou erros) é reescrita
// pelo PO nos 8 campos do DoD — MESMO formulário (InfraIssueForm) que o PO
// já usa para escrever issue nova, nunca um formato paralelo.

import { RAILS_SCHEMAS, buildStepPrompt, type InfraIssueForm } from '@gitorch/cadence'
import { runFormStep } from './rails-runner.js'
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

export async function ajustarTarefaForaDoPadrao(
  args: AjustarTarefaForaDoPadraoArgs
): Promise<InfraIssueForm | { erroDeValidacao: string }> {
  try {
    return (await runFormStep({
      schema: RAILS_SCHEMAS.infraIssue,
      prompt: buildStepPrompt('po', 'po-ajustar-tarefa-fora-do-padrao', RAILS_SCHEMAS.infraIssue, [
        ...args.contextBlocks,
        `A tarefa #${args.issueNumber} de ${args.repository} não está no padrão de 8 campos:`,
        args.conferencia.erros.join('; '),
        `Título original: ${args.tituloOriginal}`,
        `Corpo original: ${args.corpoOriginal}`,
        'Reescreva nos 8 campos do padrão, preservando a INTENÇÃO original — nunca inventando um ' +
          'pedido novo que a issue não continha.',
      ]),
      execute: args.execute,
    })) as InfraIssueForm
  } catch (err) {
    if (err instanceof Error) {
      return { erroDeValidacao: err.message }
    }
    return { erroDeValidacao: String(err) }
  }
}
