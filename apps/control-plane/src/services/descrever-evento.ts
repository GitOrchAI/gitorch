// Traduz o que a esteira faz (tipo de evento/missão, estado de missão) para
// frases em PT-BR sem jargão — o vocabulário do owner. Fonte ÚNICA: o painel
// (routes/painel.ts) usa isto hoje; o Telegram passa a usar a mesma coisa
// depois, para dizer no celular exatamente o que a tela diz (API.md §2.2/§2.3).
//
// Regra de honestidade: tipo que não conhecemos NÃO vira uma frase inventada
// com detalhe — vira a frase neutra "Movimento novo na esteira".

import { isF6AgentRole, type F6AgentRole } from '@gitorch/agents'

export interface SinalBruto {
  tipo: string
  payload?: unknown
}

// Missões de agente nascem com type `agent-run-<role>` (scheduler.ts). Além
// delas, os tipos de missão/evento que aparecem na esteira do dono.
const FRASES: Record<string, string> = {
  'agent-run-po': 'O planejamento está organizando a fila de pedidos',
  'agent-run-ra': 'A análise de requisitos está lendo um pedido',
  'agent-run-sm': 'O acompanhamento está cuidando do fluxo de trabalho',
  'agent-run-qa': 'A revisão de qualidade está avaliando uma entrega',
  agent_question: 'Um agente parou para te perguntar algo',
  qa_judgment: 'A revisão de qualidade deu um veredito sobre uma entrega',
  clone_and_start_engines: 'Preparando o ambiente do projeto',
  'mission.created': 'Uma tarefa nova começou',
  'mission.completed': 'Uma tarefa terminou',
  'mission.failed': 'Uma tarefa parou e precisa de atenção',
}

/** Frase curta em PT-BR para um sinal da esteira. Tipo desconhecido → frase neutra. */
export function descreverEvento(s: SinalBruto): string {
  return FRASES[s.tipo] ?? 'Movimento novo na esteira'
}

const PAPEL_POR_ROLE: Record<F6AgentRole, string> = {
  po: 'Produto',
  ra: 'Planejamento',
  sm: 'Planejamento',
  qa: 'Qualidade',
}

/**
 * Papel legível a partir do tipo da missão (`agent-run-<role>`). Tipo que não
 * casa um papel F6 → "Agente" (não inventa "Desenvolvimento").
 */
export function papelDoAgente(tipoMissao: string): string {
  const m = /^agent-run-([a-z]+)$/.exec(tipoMissao)
  const role = m?.[1]
  return role && isF6AgentRole(role) ? PAPEL_POR_ROLE[role] : 'Agente'
}

export type EstadoAgente = 'trabalhando' | 'esperando_voce' | 'bloqueado' | 'ocioso'

/**
 * Estado do agente para o painel colorir. `waitingStatus` presente = a missão
 * está parada esperando algo do dono. `running`/`pending` = trabalhando.
 * `failed` = bloqueado. Qualquer outra coisa (completed, cancelled…) = ocioso.
 */
export function estadoDoAgente(mission: {
  status: string
  waitingStatus?: string | null
}): EstadoAgente {
  if (mission.waitingStatus) return 'esperando_voce'
  if (mission.status === 'running' || mission.status === 'pending') return 'trabalhando'
  if (mission.status === 'failed') return 'bloqueado'
  return 'ocioso'
}
