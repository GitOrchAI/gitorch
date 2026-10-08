// Fase 2.2: quando nenhuma pista de vínculo existe (vinculo-da-tarefa.ts
// devolveu null), o RA lê o diff e o código para achar a tarefa mais
// parecida. Mesmo padrão de dois arquivos: este monta o prompt e chama o
// StepExecutor; quem decide é o motor (LLM decide, sistema executa).

import { RAILS_SCHEMAS, buildStepPrompt, type RaTarefaParecidaForm } from '@gitorch/cadence'
import { runFormStep } from './rails-runner.js'
import type { StepExecutor } from './role-rails.js'
import type { IssueCandidata } from './perguntar-vinculo-da-tarefa.js'

export interface RacharTarefaParecidaArgs {
  numeroDoPr: number
  repository: string
  diffResumo: string
  contextBlocks: string[]
  /** As issues abertas do repositório: o número devolvido só pode sair daqui. */
  issuesAbertas: IssueCandidata[]
  execute: StepExecutor
}

/** Uma linha por issue: o título vem de gente e não pode abrir linhas novas no prompt. */
function listaDeIssuesAbertas(issues: IssueCandidata[]): string {
  if (issues.length === 0) return 'Issues abertas do repositório: nenhuma.'
  const linhas = issues.map(
    (i) => `#${i.numero} — ${i.titulo.replace(/\s+/g, ' ').trim().slice(0, 140)}`
  )
  return `Issues abertas do repositório (número — título):\n${linhas.join('\n')}`
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
      listaDeIssuesAbertas(args.issuesAbertas),
      `Diff (resumo): ${args.diffResumo}`,
      'issueNumberEncontrado só pode ser o número de uma das issues abertas listadas acima. Se ' +
        'nenhuma issue aberta corresponder, devolva issueNumberEncontrado nulo — não adivinhe ' +
        'nem escolha a mais parecida "de longe".',
    ]),
    execute: args.execute,
  })) as RaTarefaParecidaForm
}
