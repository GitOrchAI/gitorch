// Helpers puros e agnósticos de framework para a UI de conexão de motores do
// setup wizard. Ficam FORA de React de propósito: a lógica (normalização de
// models, classificação de erro, prontidão do provisionamento) é testável num
// ambiente node — o app web não tem jsdom/testing-library. StepConnectEngine e
// StepReady importam os tipos e funções daqui.

// Estado de conexão de UM motor no card. `verifying` é uma fase puramente local
// (o backend NUNCA a emite): cobre a janela entre "enviei o código" e o próximo
// evento SSE, para o card não ficar idêntico (fim do dead-air).
export type LoginState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'verifying' }
  | { phase: 'url_ready'; url: string; code?: string }
  | { phase: 'connected'; models?: number; quota?: number | null }
  | { phase: 'error'; message: string }

// Forma de um motor como GET /api/v1/engines devolve (só os campos que a UI lê).
export interface EngineSnapshot {
  runtime: string
  status: string
  models?: unknown
  quotaRemaining?: number | null
}

// A liveness devolve `models` como LISTA (string[]); o refetch de /engines já
// normaliza pra contagem, mas o evento SSE `connected` entrega a lista crua.
// Fonte única de "quantos modelos" — lista -> tamanho; número -> ele mesmo;
// qualquer outra coisa -> indefinido (não renderiza a linha).
export function modelCount(models: unknown): number | undefined {
  if (Array.isArray(models)) return models.length
  if (typeof models === 'number' && Number.isFinite(models)) return models
  return undefined
}

// Resposta de POST /api/v1/engines/:runtime/token -> LoginState do card.
// Anti-fachada: só 'connected' quando o backend confirmou status==='connected'
// (a rota já roda a liveness). Qualquer outra coisa vira 'error' honesto, com a
// causa real do backend quando houver (status.lastError ou error de topo).
export function parseTokenResponse(json: unknown, fallbackError: string): LoginState {
  const body = (json ?? {}) as {
    connected?: unknown
    error?: unknown
    status?: { status?: unknown; models?: unknown; quotaRemaining?: unknown; lastError?: unknown }
  }
  const status = body.status
  if (body.connected === true && status?.status === 'connected') {
    const quota = typeof status.quotaRemaining === 'number' ? status.quotaRemaining : null
    return { phase: 'connected', models: modelCount(status.models), quota }
  }
  const lastError = typeof status?.lastError === 'string' ? status.lastError.trim() : ''
  const topError = typeof body.error === 'string' ? body.error.trim() : ''
  return { phase: 'error', message: lastError || topError || fallbackError }
}
