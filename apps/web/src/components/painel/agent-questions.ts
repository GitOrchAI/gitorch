// Dúvidas dos agentes no painel (W3.4.2) — a lógica, fora do React (mesma
// decisão de setup/telegram-link.ts e setup/submit-flow.ts: o app web não tem
// jsdom/testing-library, então o que precisa de teste mora aqui).
//
// O painel aqui é READ-ONLY: só EXIBE a dúvida (texto, contexto, opções,
// status e a resposta já dada). Responder continua sendo só pelo Telegram
// (control-plane/services/agent-question.ts + telegram-bot.ts) — ligar o
// painel para responder é backlog da próxima fase (ver
// docs/superpowers/specs/2026-07-21-w3-telegram-duvidas-design.md, seção 6).

export interface AgentQuestionOptionView {
  label: string
  value: string
}

export interface AgentQuestionView {
  id: string
  text: string
  context: string | null
  options: AgentQuestionOptionView[]
  status: string
  answer: string | null
  answeredAt: string | null
  createdAt: string
}

export interface FetchAgentQuestionsDeps {
  fetchImpl?: typeof fetch
}

/**
 * Busca as dúvidas do dono autenticado em GET /api/v1/setup/agent-questions.
 * NUNCA lança: sessão ausente (401), backend fora, rede caída ou um corpo
 * fora do shape esperado sempre viram `[]` — o painel some a seção, não
 * quebra a tela inteira por causa disto.
 */
export async function fetchAgentQuestions(
  apiBaseUrl: string,
  deps: FetchAgentQuestionsDeps = {}
): Promise<AgentQuestionView[]> {
  const doFetch = deps.fetchImpl ?? fetch
  try {
    const res = await doFetch(`${apiBaseUrl}/api/v1/setup/agent-questions`, {
      credentials: 'include',
    })
    if (!res.ok) return []
    const json = await res.json().catch(() => null)
    return parseQuestions(json)
  } catch {
    return []
  }
}

// Anti-fachada: qualquer corpo que não seja `{ questions: [...] }` vira `[]`
// em vez de espalhar `undefined`/lançar mais adiante no render.
function parseQuestions(json: unknown): AgentQuestionView[] {
  if (!json || typeof json !== 'object') return []
  const body = json as { questions?: unknown }
  if (!Array.isArray(body.questions)) return []
  return body.questions.map(toQuestionView).filter((q): q is AgentQuestionView => q !== null)
}

// Um item individual torto (sem id/text/status, por exemplo) é descartado em
// vez de derrubar a lista inteira — o resto das dúvidas continua aparecendo.
function toQuestionView(raw: unknown): AgentQuestionView | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.text !== 'string' || typeof r.status !== 'string') {
    return null
  }
  return {
    id: r.id,
    text: r.text,
    context: typeof r.context === 'string' ? r.context : null,
    options: Array.isArray(r.options) ? r.options.filter(isOptionView) : [],
    status: r.status,
    answer: typeof r.answer === 'string' ? r.answer : null,
    answeredAt: typeof r.answeredAt === 'string' ? r.answeredAt : null,
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : '',
  }
}

function isOptionView(o: unknown): o is AgentQuestionOptionView {
  if (!o || typeof o !== 'object') return false
  const r = o as Record<string, unknown>
  return typeof r.label === 'string' && typeof r.value === 'string'
}

/**
 * Abertas primeiro, depois mais recente primeiro — resiliência do FRONT além
 * da ordenação que o backend já faz (listForUser/sortOpenFirst no
 * control-plane): mesmo que a API mude de ordem no futuro, o painel continua
 * mostrando o que precisa de atenção no topo.
 */
export function sortQuestions(qs: AgentQuestionView[]): AgentQuestionView[] {
  const rank = (status: string): number => (status === 'open' ? 0 : 1)
  return [...qs].sort((a, b) => {
    const byStatus = rank(a.status) - rank(b.status)
    if (byStatus !== 0) return byStatus
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  })
}

const STATUS_LABELS: Record<string, string> = {
  open: 'Aguardando resposta',
  answered: 'Respondida',
  expired: 'Expirada',
}

/** Traduz o status pra rótulo em PT-BR; status desconhecido devolve ele mesmo (nunca inventa). */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}
