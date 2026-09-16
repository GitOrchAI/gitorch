// Fase 2.2: quando nenhuma pista de vínculo existe (vinculo-da-tarefa.ts
// devolveu null), o RA lê o diff e o código para achar a tarefa mais
// parecida. Mesmo padrão de dois arquivos: este monta o prompt e chama o
// StepExecutor; quem decide é o motor (LLM decide, sistema executa).

import { RAILS_SCHEMAS, buildStepPrompt, type RaTarefaParecidaForm } from '@gitorch/cadence'
import { runFormStep } from './rails-runner.js'
import type { StepExecutor } from './role-rails.js'

export interface RacharTarefaParecidaArgs {
  numeroDoPr: number
  repository: string
  diffResumo: string
  contextBlocks: string[]
  execute: StepExecutor
}

export async function racharTarefaParecidaPeloCodigo(
  args: RacharTarefaParecidaArgs
): Promise<RaTarefaParecidaForm> {
  return (await runFormStep({
    schema: RAILS_SCHEMAS.raTarefaParecida,
    prompt: buildStepPrompt('ra', 'ra-tarefa-parecida', RAILS_SCHEMAS.raTarefaParecida, [
      ...args.contextBlocks,
      `Pull request #${args.numeroDoPr} de ${args.repository} não traz NENHUMA pista de a qual ` +
        'tarefa ele pertence (sem vínculo formal, sem citação no corpo, sem branch do dev ' +
        'assíncrono). Leia o diff e o código real do repositório e diga se alguma ISSUE ABERTA ' +
        'descreve exatamente esta mudança.',
      `Diff (resumo): ${args.diffResumo}`,
      'Se nenhuma issue aberta corresponder, devolva issueNumberEncontrado nulo — não adivinhe ' +
        'nem escolha a mais parecida "de longe".',
    ]),
    execute: args.execute,
  })) as RaTarefaParecidaForm
}
