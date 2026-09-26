import type { ContextoExecutivoDaPergunta } from './contexto-executivo-da-pergunta.js'
import { buildFreeTextOption } from './telegram-bot.js'
import type { AgentQuestionOption } from './agent-question.js'
import type { OrigemDoItem } from './origem-do-item.js'
import { gerarPerguntaSobrePrParado, type ContextoPrParado } from './pr-parado-mission.js'
import type { StepExecutor } from './role-rails.js'

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

export function montarMensagemDeFatosBrutos(args: {
  numeroDoPr: number
  repository: string
  origem: OrigemDoItem
  contexto: ContextoExecutivoDaPergunta
  contextoPr?: ContextoPrParado
}): { text: string; options: AgentQuestionOption[]; dedupKey: string } {
  const partes: string[] = []

  if (args.contexto.ciclo) partes.push(`O time está no ciclo "${args.contexto.ciclo}".`)
  if (args.contexto.entrega) partes.push(`Esta tarefa entrega: ${args.contexto.entrega}.`)

  partes.push(`Pull Request #${args.numeroDoPr} (${args.repository})`)
  partes.push(`Título: ${args.contextoPr?.titulo}`)
  partes.push(`Origem: ${args.origem}`)
  partes.push(`Idade: ${args.contextoPr?.idadeDias} dias`)
  partes.push(`CI: ${args.contextoPr?.estadoCi}`)
  partes.push(`Conflitos: ${args.contextoPr?.conflitos ? 'Sim' : 'Não'}`)

  if (args.contextoPr?.issueLigada) {
    partes.push(
      `Issue ligada: #${args.contextoPr.issueLigada.numero} - ${args.contextoPr.issueLigada.titulo}`
    )
  } else {
    partes.push('Nenhuma issue ligada.')
  }

  partes.push('O que você quer que eu faça com ele?')

  return {
    text: partes.join('\n\n'),
    options: [buildFreeTextOption()],
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
    contextoPr?: ContextoPrParado
  },
  deps: {
    agentQuestion: AgentQuestionAskerDeCuidado
    execute?: StepExecutor
    onWarn?: (msg: string) => void
  }
): Promise<void> {
  let text = ''
  let options: AgentQuestionOption[] = []

  const maxOpcoes = 4
  const dedupKey = dedupKeyDeCuidaDestePedido(args.repository, args.numeroDoPr)

  if (deps.execute && args.contextoPr) {
    try {
      const resp = await gerarPerguntaSobrePrParado({
        contextoPr: args.contextoPr,
        execute: deps.execute,
      })

      const partes = [resp.resumo_do_pr, resp.motivo_da_espera, resp.recomendacao_do_agente]

      text = partes.join('\n\n')
      options = resp.opcoes_sob_medida.slice(0, maxOpcoes).map((op) => ({
        label: op.label,
        value: `pr-parado-${op.action}`,
      }))
      options.push(buildFreeTextOption())
    } catch (err) {
      deps.onWarn?.(`Falha ao gerar pergunta com agente para PR #${args.numeroDoPr}: ${err}`)
    }
  }

  if (!text) {
    const fallback = montarMensagemDeFatosBrutos(args)
    text = fallback.text
    options = fallback.options
  }

  await deps.agentQuestion.ask(args.userId, args.projectId, {
    text,
    options,
    dedupKey,
  })
}
