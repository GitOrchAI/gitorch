// A análise de "por que o Jules falhou 2 vezes na MESMA issue" (D51). Roda
// ANTES da 3ª tentativa. Um passo de formulário só — a LLM entende o padrão, o
// sistema aplica: grava o aprendizado (memoria-do-jules.ts) e injeta o pedido
// revisado no prompt da 3ª delegação.

import { runFormStep } from './rails-runner.js'
import type { StepExecutor } from './role-rails.js'
import type { MiniSchema } from '@gitorch/cadence'

export interface SessaoMorta {
  sessionName: string
  /** O estado terminal em que a sessão morreu (COMPLETED / FAILED / ...). */
  estado: string
  /** A última atividade / mensagem do dev naquela sessão (o mais informativo). */
  ultimaAtividade: string
}

export interface EntradaDaAnalise {
  issueNumber: number
  tituloDaIssue: string
  corpoDaIssue: string
  /** As duas (ou mais) sessões que morreram nesta issue. */
  sessoesMortas: SessaoMorta[]
  /** Os comentários de retrabalho que o QA postou nos PRs mortos. */
  comentariosDeQa: string[]
}

export interface AnaliseDeFalha {
  /** O que as tentativas tiveram EM COMUM na hora de falhar. */
  causaComum: string
  /** O que faltou NO CORPO DA ISSUE para o Jules acertar. */
  faltouNaIssue: string
  /** Um parágrafo pronto para colar no topo do pedido da 3ª tentativa. */
  pedidoRevisado: string
  /** Uma frase de "padrão do Jules" para a memória dos agentes. */
  padraoDoJules: string
}

export const SCHEMA_ANALISE_DE_FALHA: MiniSchema = {
  type: 'object',
  required: ['causaComum', 'faltouNaIssue', 'pedidoRevisado', 'padraoDoJules'],
  properties: {
    causaComum: { type: 'string' },
    faltouNaIssue: { type: 'string' },
    pedidoRevisado: { type: 'string' },
    padraoDoJules: { type: 'string' },
  },
}

/** Monta o prompt do passo de análise. Pura — sem rede. */
export function montarPromptDeAnalise(e: EntradaDaAnalise): string {
  const sessoes = e.sessoesMortas
    .map(
      (s, i) =>
        `Attempt ${i + 1} (session ${s.sessionName}, ended ${s.estado}):\n` +
        `  last activity: ${s.ultimaAtividade || '(no activity recorded)'}`
    )
    .join('\n\n')

  const qa =
    e.comentariosDeQa.length > 0
      ? e.comentariosDeQa.map((c, i) => `QA rework comment ${i + 1}:\n${c}`).join('\n\n')
      : '(no QA rework comments)'

  return [
    `Issue #${e.issueNumber} ("${e.tituloDaIssue}") was delegated to the async dev agent`,
    `${e.sessoesMortas.length} times and every attempt failed to produce a mergeable delivery.`,
    '',
    'THE ISSUE BODY (this is all the async dev sees):',
    e.corpoDaIssue,
    '',
    'THE DEAD ATTEMPTS:',
    sessoes,
    '',
    qa,
    '',
    'Analyse this and fill the form:',
    '1. causaComum — what did the attempts have in COMMON at the moment they failed?',
    '   (same missing context? same wrong file? same skipped step? CI failing for the',
    '   same reason? asked the same question?)',
    '2. faltouNaIssue — what was MISSING FROM THE ISSUE BODY that would have let the',
    '   agent get it right the first time? Be concrete (a file path, a command, a',
    '   constraint, an example).',
    '3. pedidoRevisado — one paragraph, ready to paste at the TOP of the request for',
    '   the 3rd attempt, telling the agent exactly what went wrong the last two times',
    '   and what to do differently. Written FOR the agent, imperative.',
    '4. padraoDoJules — one sentence, general, for the agents that write future issues',
    '   on this project (e.g. "CI-fix issues on this repo need the exact failing',
    '   workflow name and the command that reproduces it in the body").',
  ].join('\n')
}

/** Roda a análise (um passo de formulário). */
export async function runAnaliseDeFalha(
  execute: StepExecutor,
  entrada: EntradaDaAnalise
): Promise<AnaliseDeFalha> {
  return (await runFormStep({
    schema: SCHEMA_ANALISE_DE_FALHA,
    prompt: montarPromptDeAnalise(entrada),
    execute,
  })) as AnaliseDeFalha
}
