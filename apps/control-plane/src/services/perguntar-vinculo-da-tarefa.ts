// PO pergunta ao dono a qual tarefa um pull request pertence, quando nem o
// vínculo formal (2.1) nem o RA pelo código (2.2) acharam nada. MESMO padrão
// executivo de D71/D72/D73 que viabilidade-da-logica-alternativa.ts já usa —
// 3 opções objetivas + "Vou escrever", nunca um formato novo.

import type { ContextoExecutivoDaPergunta } from './contexto-executivo-da-pergunta.js'
import { buildFreeTextOption } from './telegram-bot.js'
import type { AgentQuestionOption } from './agent-question.js'

export const DEDUP_PREFIXO_VINCULO_DA_TAREFA = 'vinculo-da-tarefa:'

export function dedupKeyDeVinculoDaTarefa(repository: string, numeroDoPr: number): string {
  return `${DEDUP_PREFIXO_VINCULO_DA_TAREFA}${repository}:${numeroDoPr}`
}

export function parseDedupKeyDeVinculoDaTarefa(
  dedupKey: string
): { repository: string; numeroDoPr: number } | null {
  if (!dedupKey.startsWith(DEDUP_PREFIXO_VINCULO_DA_TAREFA)) return null
  const resto = dedupKey.slice(DEDUP_PREFIXO_VINCULO_DA_TAREFA.length)
  const ultimoDoisPontos = resto.lastIndexOf(':')
  if (ultimoDoisPontos <= 0 || ultimoDoisPontos === resto.length - 1) return null
  const repository = resto.slice(0, ultimoDoisPontos)
  const numeroDoPr = Number(resto.slice(ultimoDoisPontos + 1))
  if (!repository.includes('/') || !Number.isInteger(numeroDoPr) || numeroDoPr <= 0) return null
  return { repository, numeroDoPr }
}

export interface IssueCandidata {
  numero: number
  titulo: string
}

/** No máximo 3 candidatas objetivas — mesmo teto de "3 opções, nunca lista
 *  completa" que toda pergunta ao dono segue (feedback-toda-pergunta-telegram-4-opcoes). */
const MAX_CANDIDATAS = 3

export function montarPerguntaSobreVinculoDaTarefa(args: {
  numeroDoPr: number
  repository: string
  contexto: ContextoExecutivoDaPergunta
  candidatas: IssueCandidata[]
}): { text: string; options: AgentQuestionOption[]; dedupKey: string } {
  const candidatas = args.candidatas.slice(0, MAX_CANDIDATAS)
  const partes: string[] = []
  if (args.contexto.ciclo) partes.push(`O time está no ciclo "${args.contexto.ciclo}".`)
  if (args.contexto.entrega) partes.push(`Esta tarefa entrega: ${args.contexto.entrega}.`)
  if (args.contexto.decisoes.length > 0) {
    partes.push(`A equipe já resolveu sozinha: ${args.contexto.decisoes.join('; ')}.`)
  }
  partes.push(
    `O pull request #${args.numeroDoPr} de ${args.repository} chegou sem nenhuma pista de a qual ` +
      'tarefa pertence, e o analista não achou nada parecido pelo código. A qual tarefa ele pertence?'
  )

  const opcoesDeIssue: AgentQuestionOption[] = candidatas.map((c) => ({
    label: `#${c.numero} — ${c.titulo}`,
    value: `vinculo-issue-${c.numero}`,
  }))

  return {
    text: partes.join('\n\n'),
    options: [
      ...opcoesDeIssue,
      { label: 'Nenhuma destas', value: 'nenhuma-destas' },
      buildFreeTextOption(),
    ],
    dedupKey: dedupKeyDeVinculoDaTarefa(args.repository, args.numeroDoPr),
  }
}

/** Só o que esta função precisa de `AgentQuestionService.ask`. */
export interface AgentQuestionAskerDeVinculo {
  ask: (
    userId: string,
    projectId: string,
    input: { text: string; options?: AgentQuestionOption[]; dedupKey?: string }
  ) => Promise<unknown>
}

/**
 * PORTÃO 5B, item 7.6: side effect externo (mensagem real ao dono) só com
 * autorização explícita de quem despacha esta tarefa no Shrimp.
 */
export async function perguntarSobreVinculoDaTarefa(
  args: {
    userId: string
    projectId: string
    numeroDoPr: number
    repository: string
    contexto: ContextoExecutivoDaPergunta
    candidatas: IssueCandidata[]
  },
  deps: { agentQuestion: AgentQuestionAskerDeVinculo }
): Promise<void> {
  const pergunta = montarPerguntaSobreVinculoDaTarefa(args)
  await deps.agentQuestion.ask(args.userId, args.projectId, {
    text: pergunta.text,
    options: pergunta.options,
    dedupKey: pergunta.dedupKey,
  })
}
