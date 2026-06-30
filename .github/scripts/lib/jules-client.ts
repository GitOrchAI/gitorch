/**
 * Cliente mínimo da Jules API (v1alpha).
 *
 * Base: https://jules.googleapis.com — auth via header `x-goog-api-key: $JULES_API_KEY`.
 * Usado pelo handler de "apology": quando o Jules comenta que não conseguiu, lemos as
 * activities da sessão para entender o motivo e mandamos orientação via sendMessage.
 *
 * Docs: https://jules.google/docs/api/reference/sessions/ e .../activities/
 */

const JULES_BASE = 'https://jules.googleapis.com/v1alpha'

export interface JulesActivity {
  name?: string
  // O shape exato varia por tipo de activity (plan, message, update, artifact...).
  // Mantemos genérico e deixamos a LLM interpretar o JSON cru.
  [key: string]: unknown
}

/**
 * Extrai o ID da sessão a partir do corpo de um comentário do Jules.
 * O Jules linka a tarefa como `https://jules.google.com/task/<id>` (ou `/sessions/<id>`).
 * Retorna o id ou null se não encontrar.
 */
export function extractSessionId(commentBody: string): string | null {
  const patterns = [
    /jules\.google\.com\/task\/([A-Za-z0-9_-]+)/,
    /jules\.google\.com\/sessions\/([A-Za-z0-9_-]+)/,
    /sessions\/([A-Za-z0-9_-]+)/,
  ]
  for (const p of patterns) {
    const m = commentBody.match(p)
    if (m?.[1]) return m[1]
  }
  return null
}

export class JulesClient {
  private readonly apiKey: string

  constructor(apiKey: string) {
    if (!apiKey) throw new Error('JULES_API_KEY é obrigatório')
    this.apiKey = apiKey
  }

  private get headers(): Record<string, string> {
    return { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' }
  }

  /** Lê as atividades da sessão (mensagens, plano, updates) — onde está o motivo da falha. */
  async getActivities(sessionId: string, pageSize = 30): Promise<JulesActivity[]> {
    const res = await fetch(
      `${JULES_BASE}/sessions/${encodeURIComponent(sessionId)}/activities?pageSize=${pageSize}`,
      { headers: this.headers }
    )
    if (!res.ok) {
      throw new Error(`Jules getActivities falhou (${res.status}): ${await res.text()}`)
    }
    const data = (await res.json()) as { activities?: JulesActivity[] }
    return data.activities ?? []
  }

  /** Detalhes da sessão (estado, outputs). */
  async getSession(sessionId: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${JULES_BASE}/sessions/${encodeURIComponent(sessionId)}`, {
      headers: this.headers,
    })
    if (!res.ok) {
      throw new Error(`Jules getSession falhou (${res.status}): ${await res.text()}`)
    }
    return (await res.json()) as Record<string, unknown>
  }

  /** Envia uma orientação para a sessão prosseguir. Retorna true em sucesso. */
  async sendMessage(sessionId: string, prompt: string): Promise<boolean> {
    const res = await fetch(`${JULES_BASE}/sessions/${encodeURIComponent(sessionId)}:sendMessage`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ prompt }),
    })
    if (!res.ok) {
      throw new Error(`Jules sendMessage falhou (${res.status}): ${await res.text()}`)
    }
    return true
  }

  /** Lista sessões (fallback para casar sessão por source/branch quando falta o link). */
  async listSessions(pageSize = 30): Promise<Record<string, unknown>[]> {
    const res = await fetch(`${JULES_BASE}/sessions?pageSize=${pageSize}`, {
      headers: this.headers,
    })
    if (!res.ok) {
      throw new Error(`Jules listSessions falhou (${res.status}): ${await res.text()}`)
    }
    const data = (await res.json()) as { sessions?: Record<string, unknown>[] }
    return data.sessions ?? []
  }
}

/** Detecta se um comentário é uma "apology" do Jules (não conseguiu completar). */
export function isJulesApology(commentBody: string): boolean {
  return /I apologize|wasn'?t able to complete|cannot complete|could not complete|unable to (complete|resolve)|não consegui|n[ãa]o consigo/i.test(
    commentBody
  )
}
