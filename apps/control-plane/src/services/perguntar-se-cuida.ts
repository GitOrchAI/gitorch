import type { ContextoExecutivoDaPergunta } from './contexto-executivo-da-pergunta.js'
import { buildFreeTextOption } from './telegram-bot.js'
import type { AgentQuestionOption } from './agent-question.js'
import type { OrigemDoItem } from './origem-do-item.js'

export const DEDUP_PREFIXO_CUIDA_DESTE_PEDIDO = 'cuida-deste-pedido:'

export function dedupKeyDeCuidaDestePedido(repository: string, numeroDoPr: number): string {
  return `${DEDUP_PREFIXO_CUIDA_DESTE_PEDIDO}${repository}:${numeroDoPr}`
}

export function parseDedupKeyDeCuidaDestePedido(
  dedupKey: string
): { repository: string; numeroDoPr: number } | null {
  if (!dedupKey.startsWith(DEDUP_PREFIXO_CUIDA_DESTE_PEDIDO)) return null
  const resto = dedupKey.slice(DEDUP_PREFIXO_CUIDA_DESTE_PEDIDO.length)
  const i = resto.lastIndexOf(':')
  if (i <= 0 || i === resto.length - 1) return null
  const repository = resto.slice(0, i)
  const numeroDoPr = Number(resto.slice(i + 1))
  if (!repository.includes('/') || !Number.isInteger(numeroDoPr) || numeroDoPr <= 0) return null
  return { repository, numeroDoPr }
}

export const OPCOES_DE_CUIDA_DESTE_PEDIDO: AgentQuestionOption[] = [
  { label: 'Sim, cuide sozinho a partir de agora', value: 'cuidar-sempre' },
  { label: 'Só desta vez', value: 'cuidar-uma-vez' },
  { label: 'Não, só acompanhe', value: 'nao-cuidar' },
]

export function montarPerguntaSeCuida(args: {
  numeroDoPr: number
  repository: string
  origem: OrigemDoItem
  contexto: ContextoExecutivoDaPergunta
}): { text: string; options: AgentQuestionOption[]; dedupKey: string } {
  const partes: string[] = []
  if (args.contexto.ciclo) partes.push(`O time está no ciclo "${args.contexto.ciclo}".`)
  if (args.contexto.entrega) partes.push(`Esta tarefa entrega: ${args.contexto.entrega}.`)
  partes.push(
    `O pull request #${args.numeroDoPr} de ${args.repository} (origem: ${args.origem}) está pronto ` +
      'para julgamento, e você configurou esta origem para eu perguntar antes. Cuido deste pedido?'
  )
  return {
    text: partes.join('\n\n'),
    options: [...OPCOES_DE_CUIDA_DESTE_PEDIDO, buildFreeTextOption()],
    dedupKey: dedupKeyDeCuidaDestePedido(args.repository, args.numeroDoPr),
  }
}

export interface AgentQuestionAskerDeCuidado {
  ask: (
    userId: string,
    projectId: string,
    input: { text: string; options?: AgentQuestionOption[]; dedupKey?: string }
  ) => Promise<unknown>
}

export async function perguntarSeCuida(
  args: {
    userId: string
    projectId: string
    numeroDoPr: number
    repository: string
    origem: OrigemDoItem
    contexto: ContextoExecutivoDaPergunta
  },
  deps: { agentQuestion: AgentQuestionAskerDeCuidado }
): Promise<void> {
  const pergunta = montarPerguntaSeCuida(args)
  await deps.agentQuestion.ask(args.userId, args.projectId, {
    text: pergunta.text,
    options: pergunta.options,
    dedupKey: pergunta.dedupKey,
  })
}
