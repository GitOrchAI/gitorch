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
  | {
      phase: 'connected'
      models?: string[]
      quota?: number | null
      // Claude (ver quota-reader.ts no control-plane — headers de rate limit
      // da API da Anthropic): não existe remaining/total — existe % USADO de
      // duas janelas independentes (sessão/semana) + o horário de reset de
      // cada uma. Só populado pro Claude; Codex/Antigravity continuam só em
      // `quota`.
      sessionPercentUsed?: number | null
      sessionResetsAt?: string | null
      weekPercentUsed?: number | null
      weekResetsAt?: string | null
    }
  | { phase: 'error'; message: string }
  /**
   * O motor ESTAVA conectado e parou de valer: só volta com login novo.
   *
   * Nasceu do print do dono (26/08): este card mostrava o Codex verde,
   * "Conectado", com os modelos listados, enquanto TODA missão morria por
   * credencial vencida. A tela não era a culpada — ela repetia fielmente a
   * coluna `status` do banco, que ninguém atualizava quando a missão caía.
   * Corrigido o backend (motor-que-pede-login.ts), a tela ganha o estado que
   * faltava.
   *
   * É DIFERENTE de `error`: `error` é uma tentativa de conectar que deu errado
   * agora, e por isso o card abre dicas de token e colagem manual. Aqui não
   * houve tentativa nenhuma — uma conexão que funcionava venceu sozinha, e a
   * única coisa a oferecer é religar.
   */
  | { phase: 'precisa_religar' }

// 20/07: substitui o antigo `modelCount`, que reduzia a lista de modelos a um
// NÚMERO. O dono reclamou direto olhando a tela ("mostra os modelos? mostra
// as quotas?") — o backend (engine-connection.ts) já manda os NOMES reais,
// nunca hardcoded pra Codex/Antigravity; era só o front jogando a lista fora.
// Valida `models` cru (do SSE ao vivo ou do refetch, mesmo formato dos dois)
// como lista de nomes: filtra qualquer entrada que não seja string (payload
// malformado perde só a entrada ruim, não quebra o card) e devolve undefined
// quando nem é lista — a linha simplesmente não renderiza.
export function normalizeModelNames(models: unknown): string[] | undefined {
  if (!Array.isArray(models)) return undefined
  return models.filter((m): m is string => typeof m === 'string')
}

/**
 * O status que o backend grava quando um motor só volta com login novo.
 * Espelha `STATUS_PRECISA_RELIGAR` do control-plane (motor-que-pede-login.ts);
 * é o MESMO valor que a renovação do GitHub já usava.
 */
export const STATUS_PRECISA_RELIGAR = 'needs_reconnect'

/** Uma linha de motor como `GET /api/v1/engines` devolve. */
export interface MotorDaLista {
  runtime: string
  status: string
  models?: unknown
  quotaRemaining?: number | null
  sessionPercentUsed?: number | null
  sessionResetsAt?: string | null
  weekPercentUsed?: number | null
  weekResetsAt?: string | null
}

/**
 * O estado do card a partir da linha do servidor — ou `null` quando não há o
 * que dizer (motor nunca conectado), e o card segue em `idle`.
 *
 * Existe como função PURA, fora do React, pelo mesmo motivo do resto deste
 * arquivo: o app web não tem jsdom, e esta é justamente a decisão que estava
 * errada em produção. O teste dela é o print do dono virado em regressão.
 *
 * Anti-fachada, agora nos DOIS sentidos: 'connected' só com o backend dizendo
 * `connected` (como antes), e o que NÃO está conectado deixa de sumir do card
 * como se nunca tivesse existido.
 */
export function estadoDoMotorDaLista(eng: MotorDaLista | undefined): LoginState | null {
  if (!eng) return null
  if (eng.status === STATUS_PRECISA_RELIGAR) return { phase: 'precisa_religar' }
  if (eng.status !== 'connected') return null
  return {
    phase: 'connected',
    ...(normalizeModelNames(eng.models) ? { models: normalizeModelNames(eng.models) } : {}),
    quota: eng.quotaRemaining ?? null,
    ...(typeof eng.sessionPercentUsed === 'number'
      ? { sessionPercentUsed: eng.sessionPercentUsed }
      : {}),
    ...(typeof eng.sessionResetsAt === 'string' ? { sessionResetsAt: eng.sessionResetsAt } : {}),
    ...(typeof eng.weekPercentUsed === 'number' ? { weekPercentUsed: eng.weekPercentUsed } : {}),
    ...(typeof eng.weekResetsAt === 'string' ? { weekResetsAt: eng.weekResetsAt } : {}),
  }
}

// Resposta de POST /api/v1/engines/:runtime/token -> LoginState do card.
// Anti-fachada: só 'connected' quando o backend confirmou status==='connected'
// (a rota já roda a liveness). Qualquer outra coisa vira 'error' honesto, com a
// causa real do backend quando houver (status.lastError ou error de topo).
export function parseTokenResponse(json: unknown, fallbackError: string): LoginState {
  const body = (json ?? {}) as {
    connected?: unknown
    error?: unknown
    status?: {
      status?: unknown
      models?: unknown
      quotaRemaining?: unknown
      lastError?: unknown
      sessionPercentUsed?: unknown
      sessionResetsAt?: unknown
      weekPercentUsed?: unknown
      weekResetsAt?: unknown
    }
  }
  const status = body.status
  if (body.connected === true && status?.status === 'connected') {
    const quota = typeof status.quotaRemaining === 'number' ? status.quotaRemaining : null
    return {
      phase: 'connected',
      models: normalizeModelNames(status.models),
      quota,
      ...claudeUsageFields(status),
    }
  }
  const lastError = typeof status?.lastError === 'string' ? status.lastError.trim() : ''
  const topError = typeof body.error === 'string' ? body.error.trim() : ''
  return { phase: 'error', message: lastError || topError || fallbackError }
}

// Normaliza o payload cru do evento SSE `state` num LoginState do card. O
// backend serializa `models` do connected como LISTA — o mesmo formato que o
// refetch de /engines devolve. Os dois caminhos (SSE ao vivo e refetch) agora
// preservam os NOMES até o componente; é ele quem decide como exibir (join
// por vírgula). Payload malformado vira erro honesto em vez de um card
// quebrado.
export function normalizeLoginState(raw: unknown, fallbackError: string): LoginState {
  const r = (raw ?? {}) as {
    phase?: unknown
    url?: unknown
    code?: unknown
    models?: unknown
    quota?: unknown
    message?: unknown
    sessionPercentUsed?: unknown
    sessionResetsAt?: unknown
    weekPercentUsed?: unknown
    weekResetsAt?: unknown
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
        models: normalizeModelNames(r.models),
        quota: typeof r.quota === 'number' ? r.quota : null,
        ...claudeUsageFields(r),
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

// Extrai só os campos de quota REAL do Claude (sessionPercentUsed/
// sessionResetsAt/weekPercentUsed/weekResetsAt — ver quota-reader.ts no
// control-plane, headers de rate limit da API da Anthropic) de um payload cru
// (POST /token ou SSE), incluindo cada chave SÓ quando o tipo bate — nunca um
// `null` forçado. Isso preserva o formato exato de {phase,models,quota}
// quando o backend não manda
// esses campos (Codex/Antigravity, ou uma resposta antiga em cache), sem
// chaves extras aparecendo no objeto.
function claudeUsageFields(r: {
  sessionPercentUsed?: unknown
  sessionResetsAt?: unknown
  weekPercentUsed?: unknown
  weekResetsAt?: unknown
}): {
  sessionPercentUsed?: number
  sessionResetsAt?: string
  weekPercentUsed?: number
  weekResetsAt?: string
} {
  return {
    ...(typeof r.sessionPercentUsed === 'number'
      ? { sessionPercentUsed: r.sessionPercentUsed }
      : {}),
    ...(typeof r.sessionResetsAt === 'string' && r.sessionResetsAt
      ? { sessionResetsAt: r.sessionResetsAt }
      : {}),
    ...(typeof r.weekPercentUsed === 'number' ? { weekPercentUsed: r.weekPercentUsed } : {}),
    ...(typeof r.weekResetsAt === 'string' && r.weekResetsAt
      ? { weekResetsAt: r.weekResetsAt }
      : {}),
  }
}

// TODOS os 3 motores expõem a quota como % USADO de janela(s) de sessão/semana
// — Claude (headers da API), Codex (evento rate_limits), Antigravity (/usage no
// chat). Antes gated em `runtime === 'claude'` (a coleta começou pelo Claude),
// o que fazia Codex/Antigravity NÃO mostrarem a quota no card mesmo tendo o
// dado — achado ao vivo 21/07: o Codex conectava com "semana 8% usada" no
// backend, mas o card não desenhava nada. Sem gate de runtime: qualquer motor
// com os campos preenchidos exibe. (Substituiu isClaudeQuotaManagedByPlan, a
// legenda genérica que o dono rejeitou — "tem que coletar!".)
export function hasUsageWindowData(state: LoginState): boolean {
  return (
    state.phase === 'connected' &&
    (typeof state.sessionPercentUsed === 'number' || typeof state.weekPercentUsed === 'number')
  )
}

// Rótulos localizados (vêm de fora — useLanguage/t() não existe fora de
// React) pra montar a única linha de texto com as duas janelas.
export interface ClaudeUsageLabels {
  session: string
  week: string
  used: string
  resets: string
}

// Monta "Sessão: 100% usada (reseta Jul 21, 3:09am (UTC)) · Semana: 41%
// usada (reseta Jul 26, 5:59pm (UTC))" a partir do estado 'connected' — só as
// janelas com percentual reconhecido entram (nunca inventa "0%"); o reset só
// aparece quando o backend o capturou. null se não há nenhuma janela (chamar
// só depois de hasClaudeUsageData confirmar que há dado).
export function formatClaudeUsage(state: LoginState, labels: ClaudeUsageLabels): string | null {
  if (state.phase !== 'connected') return null
  const parts = [
    formatClaudeUsageWindow(
      labels.session,
      state.sessionPercentUsed,
      state.sessionResetsAt,
      labels
    ),
    formatClaudeUsageWindow(labels.week, state.weekPercentUsed, state.weekResetsAt, labels),
  ].filter((p): p is string => p != null)
  return parts.length > 0 ? parts.join(' · ') : null
}

// Formata o horário de reset da quota (ex.: "2026-07-26T17:00:47.000Z", um ISO
// vindo do backend) numa data curta e legível no FUSO do navegador — "26/07
// 14:00" em vez do ISO cru que o dono via no card (21/07). Se `resetsAt` não
// for uma data parseável (um formato de texto legado), devolve como veio (nunca
// esconde a informação). `undefined` no locale usa o do próprio navegador.
export function formatResetTime(resetsAt: string): string {
  const ts = Date.parse(resetsAt)
  if (Number.isNaN(ts)) return resetsAt
  return new Date(ts).toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatClaudeUsageWindow(
  windowLabel: string,
  percentUsed: number | null | undefined,
  resetsAt: string | null | undefined,
  labels: ClaudeUsageLabels
): string | null {
  if (typeof percentUsed !== 'number') return null
  const reset = resetsAt ? ` (${labels.resets} ${formatResetTime(resetsAt)})` : ''
  return `${windowLabel}: ${percentUsed}% ${labels.used}${reset}`
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

// Versões REAIS instaladas no ambiente isolado do cliente (W1: o gate desta
// fase é o dono VER isto, não supor). Espelha o que o backend devolve em
// `environment.resources` (setup.ts, via summarizeResourcesLock) — só
// name+version dos motores + o commit curto dos recursos, nunca path/sha.
export interface EnvironmentEngineVersion {
  name: string
  version: string
}

export interface EnvironmentResources {
  engines: EnvironmentEngineVersion[]
  commit: string
}

export interface ProvisionSnapshot {
  status: ProvisionStatus
  // Causa REAL da falha (Mission.error, gravada pelo scheduler). null quando não
  // há falha ou o backend não registrou motivo — a UI cai num texto localizado.
  error: string | null
  // Posição (1-based) na fila global do scheduler — a MENOR entre as missões
  // deste submit que ainda estão pending (o backend só a preenche quando o
  // teto de concorrência está cheio; ver scheduler.ts:selectClaimableSetupMissions).
  // null fora do estado 'pending' ou quando o backend não devolveu nenhuma.
  queuePosition: number | null
  // null enquanto o bootstrap de recursos não terminou (ou não há ambiente
  // ainda) — o StepReady mostra "preparando", nunca uma versão inventada.
  environmentResources: EnvironmentResources | null
}

function parseEnvironmentResources(raw: unknown): EnvironmentResources | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const body = raw as { engines?: unknown; commit?: unknown }
  if (!Array.isArray(body.engines) || typeof body.commit !== 'string' || !body.commit.trim()) {
    return null
  }
  const engines: EnvironmentEngineVersion[] = []
  for (const entry of body.engines) {
    const e = entry as { name?: unknown; version?: unknown } | null
    if (typeof e?.name === 'string' && e.name && typeof e?.version === 'string' && e.version) {
      engines.push({ name: e.name, version: e.version })
    }
  }
  // Um lock malformado (motor sem nome/versão válidos) não vira um bloco pela
  // metade — descarta por inteiro, como o backend já faz.
  if (engines.length !== body.engines.length || engines.length === 0) return null
  return { engines, commit: body.commit.trim() }
}

export function parseSetupStatus(json: unknown): ProvisionSnapshot {
  const body = (json ?? {}) as {
    status?: unknown
    error?: unknown
    missions?: unknown
    environment?: unknown
  }
  const status = PROVISION_STATUSES.find((s) => s === body.status) ?? 'unknown'
  const error = typeof body.error === 'string' && body.error.trim() ? body.error.trim() : null
  const missions = Array.isArray(body.missions) ? body.missions : []
  const queuePositions = missions
    .map((m) => (m as { queuePosition?: unknown } | null)?.queuePosition)
    .filter((p): p is number => typeof p === 'number' && Number.isFinite(p))
  const environment = (body.environment ?? null) as {
    resources?: unknown
    // Progresso do bootstrap (ClientEnvironment.resourcesStatus no backend),
    // desacoplado do ciclo de vida — correção do bug de timing (W1). Contrato
    // alinhado com GET /setup/status; a UI continua decidindo só por
    // `resources` não-nulo vs nulo (ver parseEnvironmentResources acima),
    // então este campo não muda comportamento agora — só evita o tipo ficar
    // desalinhado da resposta real do backend.
    resourcesStatus?: string | null
  } | null
  // Causa/posição só fazem sentido no estado correspondente: um `error`
  // pendurado num estado bom seria ruído, e uma posição de fila fora de
  // 'pending' não significa nada (já não está esperando).
  return {
    status,
    error: status === 'failed' ? error : null,
    queuePosition:
      status === 'pending' && queuePositions.length > 0 ? Math.min(...queuePositions) : null,
    environmentResources: environment ? parseEnvironmentResources(environment.resources) : null,
  }
}

// Nomes de exibição — os MESMOS 3 motores dos cards de StepConnectEngine
// (runtime -> nome bonito). Um motor fora dessa lista (nunca deveria
// acontecer — o backend só reconhece estes 3) cai no nome cru em vez de
// desaparecer: melhor mostrar algo do que esconder um motor real instalado.
const ENGINE_DISPLAY_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
}

// Texto honesto pro StepReady: "Claude Code 2.1.200 · Codex 0.142.5 · ...".
export function formatEngineVersions(engines: EnvironmentEngineVersion[]): string {
  return engines.map((e) => `${ENGINE_DISPLAY_NAMES[e.name] ?? e.name} ${e.version}`).join(' · ')
}

// Estados em que o provisionamento ACABOU (o polling para). 'unknown' não é
// terminal: ainda não sabemos, então continuamos perguntando.
export function isProvisionTerminal(status: ProvisionStatus): boolean {
  return status === 'completed' || status === 'failed'
}

// Visibilidade do accordion de paste manual (rede de segurança do login
// assistido). Bug real visto pelo dono (18/07): o accordion ficava sempre
// renderizado (só recolhido) ao lado do campo de código durante `url_ready` —
// um clique de curiosidade abria os dois campos lado a lado e o código da
// página de autorização acabava colado no campo de TOKEN errado. Agora o
// accordion só existe de verdade em duas situações: o login assistido FALHOU
// (fase 'error' — aí é rede de segurança de fato, abre sozinha) ou a pessoa
// pediu explicitamente pelo link discreto "Problemas? Colar manualmente"
// (`manualRequested`, por motor). Fora isso, nem renderiza.
export function isManualAccordionVisible(
  phase: LoginState['phase'],
  manualRequested: boolean
): boolean {
  return phase === 'error' || manualRequested
}

// Formato do device code que as páginas de autorização mostram para digitar
// de volta no CLI (ex.: GitHub, Antigravity): blocos alfanuméricos curtos
// separados por hífen, tipo WDJQ-MZBG. Case-insensitive — a página mostra
// maiúsculo, mas nada garante que a pessoa preserve o caso ao copiar.
const DEVICE_CODE_PATTERN = /^[A-Za-z0-9]{4,8}-[A-Za-z0-9]{4,8}$/

// Acima deste tamanho, uma string sem o prefixo esperado já não parece um
// código curto de autorização — é só uma credencial inválida (não vira "cole
// no campo certo", vira o erro genérico de sempre).
const SHORT_PASTE_LIMIT = 20

/**
 * Detecta se o que foi colado no campo de TOKEN manual tem cara do CÓDIGO da
 * página de autorização, não de uma credencial real — é exatamente o erro
 * humano que gerou "esperado sk-ant-oat" para um código que nunca deveria ter
 * ido parar ali. Dispara com o formato de device code (qualquer runtime) ou,
 * para Claude especificamente (único com prefixo documentado, sk-ant-oat),
 * qualquer string curta que não comece com esse prefixo.
 */
export function looksLikeAuthCode(pasted: string, runtime: string): boolean {
  const v = pasted.trim()
  if (!v) return false
  if (DEVICE_CODE_PATTERN.test(v)) return true
  if (
    runtime === 'claude' &&
    v.length <= SHORT_PASTE_LIMIT &&
    !v.toLowerCase().startsWith('sk-ant-oat')
  ) {
    return true
  }
  return false
}
