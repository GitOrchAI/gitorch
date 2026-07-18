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

// Normaliza o payload cru do evento SSE `state` num LoginState do card. O ponto
// central: o backend serializa `models` do connected como LISTA — sem isto o
// card renderizava a lista inteira ("gpt-5,o4 modelos") AO VIVO, enquanto o
// refetch de /engines mostrava a contagem certa. Aqui a fase connected passa a
// contagem, casando o caminho ao vivo com o do refetch. Payload malformado vira
// erro honesto em vez de um card quebrado.
export function normalizeLoginState(raw: unknown, fallbackError: string): LoginState {
  const r = (raw ?? {}) as {
    phase?: unknown
    url?: unknown
    code?: unknown
    models?: unknown
    quota?: unknown
    message?: unknown
  }
  switch (r.phase) {
    case 'starting':
      return { phase: 'starting' }
    case 'verifying':
      return { phase: 'verifying' }
    case 'url_ready':
      if (typeof r.url === 'string') {
        return {
          phase: 'url_ready',
          url: r.url,
          ...(typeof r.code === 'string' ? { code: r.code } : {}),
        }
      }
      return { phase: 'error', message: fallbackError }
    case 'connected':
      return {
        phase: 'connected',
        models: modelCount(r.models),
        quota: typeof r.quota === 'number' ? r.quota : null,
      }
    case 'error':
      return {
        phase: 'error',
        message: typeof r.message === 'string' && r.message.trim() ? r.message : fallbackError,
      }
    default:
      return { phase: 'error', message: fallbackError }
  }
}

// Tipo de falha de conexão, para uma mensagem ACIONÁVEL (aponta o paste manual)
// em vez de só "tente novamente".
export type ConnectErrorKind = 'terms' | 'capture' | 'generic'

// Classifica a mensagem de erro do backend por tipo. `terms` = a tela de Termos
// do Antigravity (precisa aceite); `capture` = o token/credencial não foi
// capturado ou a liveness reprovou; `generic` = o resto (rede etc.).
export function classifyConnectError(message: string | undefined): ConnectErrorKind {
  const m = (message ?? '').toLowerCase()
  if (/term/.test(m)) return 'terms'
  if (
    /captur|token|credenc|credential|não encontr|not found|valida|liveness|respond|encerr/.test(m)
  )
    return 'capture'
  return 'generic'
}

// Chave de locale da dica acionável por tipo de erro — todas apontam o paste
// manual (que fica logo abaixo, aberto no estado de erro), com texto adequado.
export function connectErrorHintKey(kind: ConnectErrorKind): string {
  switch (kind) {
    case 'terms':
      return 'setup.connectErrorHintTerms'
    case 'capture':
      return 'setup.connectErrorHintCapture'
    default:
      return 'setup.connectErrorHintGeneric'
  }
}

// Provisionamento no StepReady: a VERDADE vem de GET /api/v1/setup/status, que
// lê o estado real da missão `clone_and_start_engines` no banco (a mesma que o
// submit enfileira e o scheduler processa).
//
// O sinal anterior — "algum motor conectado em GET /api/v1/engines" — era uma
// TAUTOLOGIA: o submit só passa se já houver um motor conectado, e a linha
// 'github' nasce 'connected' no login OAuth. O primeiro poll SEMPRE achava um
// motor conectado e pintava "ambiente ativo ✓" na hora, enquanto a missão ainda
// estava 'pending' e só seria processada até 60s depois. Sucesso falso — e os
// estados 'provisioning'/'failed' eram inalcançáveis.
const PROVISION_STATUSES = ['unknown', 'pending', 'running', 'completed', 'failed'] as const
export type ProvisionStatus = (typeof PROVISION_STATUSES)[number]

export interface ProvisionSnapshot {
  status: ProvisionStatus
  // Causa REAL da falha (Mission.error, gravada pelo scheduler). null quando não
  // há falha ou o backend não registrou motivo — a UI cai num texto localizado.
  error: string | null
}

export function parseSetupStatus(json: unknown): ProvisionSnapshot {
  const body = (json ?? {}) as { status?: unknown; error?: unknown }
  const status = PROVISION_STATUSES.find((s) => s === body.status) ?? 'unknown'
  const error = typeof body.error === 'string' && body.error.trim() ? body.error.trim() : null
  // Causa só faz sentido na falha: um `error` pendurado num estado bom seria
  // ruído (e nada pode manchar um provisionamento que deu certo).
  return { status, error: status === 'failed' ? error : null }
}

// Estados em que o provisionamento ACABOU (o polling para). 'unknown' não é
// terminal: ainda não sabemos, então continuamos perguntando.
export function isProvisionTerminal(status: ProvisionStatus): boolean {
  return status === 'completed' || status === 'failed'
}
