import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  readClaudeTokenFromHome,
  CLAUDE_API_BASE,
  CLAUDE_API_TIMEOUT_MS,
  claudeApiHeaders,
} from './claude-token.js'
import { numberish, envReading, type QuotaReading, type QuotaReader } from './quota-env.js'
import { readAntigravityQuota } from './antigravity-quota-reader.js'

// Leitura DINÂMICA da quota restante por motor (BYOK). Espelha o padrão do
// model-catalog: cada motor lê de um jeito próprio; nada hardcoded. Best-effort:
// se o motor não expõe quota, devolve { remaining: null } e o spend-guard trata
// como 'unknown' (não bloqueia). Sempre dá pra sobrescrever por ambiente.
//
// QuotaReading/QuotaReader/numberish/envReading agora vivem em quota-env.ts
// (módulo-folha, 21/07) — RE-EXPORTADOS aqui pra todo o resto do control-plane
// que já importa `type QuotaReading`/`type QuotaReader` DE quota-reader.ts
// continuar funcionando sem mudança nenhuma (engine-connection.ts,
// engine-liveness.ts, fake-engines.ts). Ver o comentário de quota-env.ts para
// o PORQUÊ da extração (quebrar um ciclo de import com
// antigravity-quota-reader.ts, importado logo abaixo).
export type { QuotaReading, QuotaReader }

const UNKNOWN: QuotaReading = { remaining: null, total: null }

// Unknown específico do Claude: TODOS os 6 campos null (nunca undefined) —
// "tudo null, nunca lança" mesmo quando o binário falha/dá timeout/a saída
// vem vazia ou sem as linhas esperadas. Separado do UNKNOWN genérico acima
// (usado por parseQuotaText/Codex/Antigravity) para não mudar o formato de
// 2 campos que os testes deles já travam.
const EMPTY_CLAUDE_QUOTA: QuotaReading = {
  remaining: null,
  total: null,
  sessionPercentUsed: null,
  sessionResetsAt: null,
  weekPercentUsed: null,
  weekResetsAt: null,
}

/** Extrai {remaining,total} de um texto/JSON de quota. Puro e testável. */
export function parseQuotaText(text: string): QuotaReading {
  const trimmed = text.trim()
  if (!trimmed) return UNKNOWN
  // Tenta JSON primeiro: { remaining, total } ou { remaining_tokens, limit }.
  try {
    const j = JSON.parse(trimmed) as Record<string, unknown>
    const remaining = numberish(j['remaining'] ?? j['remaining_tokens'] ?? j['tokens_remaining'])
    const total = numberish(j['total'] ?? j['limit'] ?? j['quota'])
    if (remaining != null || total != null) return { remaining, total }
  } catch {
    // não é JSON — cai no parse por regex abaixo
  }
  const remaining = matchNumber(trimmed, /remaining[^0-9-]*([0-9][0-9,._]*)/i)
  const total = matchNumber(trimmed, /(?:total|limit|quota)[^0-9-]*([0-9][0-9,._]*)/i)
  if (remaining == null && total == null) return UNKNOWN
  return { remaining, total }
}

function matchNumber(text: string, re: RegExp): number | null {
  const m = re.exec(text)
  if (!m || !m[1]) return null
  const n = Number(m[1].replace(/[,_\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

// Antigravity: REMOVIDO 21/07 o `makeAntigravityQuotaReader` que rodava
// `agy usage` via `execFile` (defaultRunner, sem TTY). Provado ao vivo (ver
// docs/operations/engine-collection-real-steps.md, seção Antigravity): esse
// comando FALHA sem TTY (`CLI error: bubbletea: could not open TTY`) — e
// mesmo COM TTY, `agy usage` não é o comando de quota (abre o chat normal).
// A quota do Antigravity NUNCA funcionou por este caminho. Mesmo padrão de
// remoção que `parseClaudeUsageText` (Claude, removida 21/07) e a leitura de
// `~/.codex/usage.json` (Codex, removida 21/07): a fonte real vem de outro
// lugar — aqui, o slash `/usage` DENTRO do chat TUI do `agy`, que exige PTY.
// Ver `makeAntigravityQuotaReaderPty` em antigravity-quota-reader.ts.

// Unknown específico do Codex: mesmos 6 campos null do EMPTY_CLAUDE_QUOTA
// (nunca undefined) — reaproveita o formato sessão/semana criado pro Claude
// (ver comentário de QuotaReading acima) em vez do UNKNOWN genérico de 2
// campos, para o front tratar os dois motores da mesma forma quando a
// coleta falha ou nunca rodou.
const EMPTY_CODEX_QUOTA: QuotaReading = {
  remaining: null,
  total: null,
  sessionPercentUsed: null,
  sessionResetsAt: null,
  weekPercentUsed: null,
  weekResetsAt: null,
}

// ---- Codex: quota via evento `rate_limits` do `codex exec --json` ----
//
// `~/.codex/usage.json` NUNCA existe (provado ao vivo 21/07, ver
// docs/operations/engine-collection-real-steps.md): nem logo após o login,
// nem depois do warmup — só `auth.json` e `models_cache.json` aparecem. A
// quota real vem de um evento JSONL `rate_limits` emitido no STDOUT do
// `codex exec --json` — o MESMO comando que o warmup do model-catalog já
// roda pra gerar `models_cache.json` (ver `defaultCodexWarmUp` em
// model-catalog.ts). Nunca rodamos `codex exec` duas vezes: o warmup extrai
// o evento desse único stdout e grava `~/.codex/gitorch-quota.json`; esta
// leitura só lê esse arquivo.

/** Uma janela de rate limit do Codex, como vem no evento `rate_limits`.
 * `used_percent` já é PERCENTUAL (0..100) — ao contrário do Claude, que
 * manda uma fração (0..1) no header e por isso precisa de
 * `utilizationToPercent`. NÃO reaplicar essa conversão aqui. */
export interface CodexRateLimitWindow {
  used_percent: number
  window_minutes: number
  reset_after_seconds?: number
  reset_at: number
}

/** Evento bruto `rate_limits` do `codex exec --json`. `primary` é a janela
 * semanal (`window_minutes` 10080 = 7 dias); `secondary`, quando existe, é a
 * janela curta (~5h, de planos pagos) — `null` no plano free (provado ao
 * vivo com a conta do dono, 21/07). */
export interface CodexRateLimitsEvent {
  allowed?: boolean
  limit_reached?: boolean
  primary: CodexRateLimitWindow | null
  secondary: CodexRateLimitWindow | null
}

/** Formato gravado em `~/.codex/gitorch-quota.json`: os campos de `primary`
 * são achatados pro nível raiz (used_percent/window_minutes/reset_at);
 * `secondary` fica aninhado (ou `null`). */
export interface CodexQuotaFile {
  used_percent: number | null
  window_minutes: number | null
  reset_at: number | null
  secondary: {
    used_percent: number | null
    window_minutes: number | null
    reset_at: number | null
  } | null
}

const CODEX_QUOTA_FILE_NAME = 'gitorch-quota.json'

/** Caminho de `~/.codex/gitorch-quota.json` — usado tanto pra gravar (warmup
 * em model-catalog.ts) quanto pra ler (readCodexQuota abaixo). */
export function codexQuotaFilePath(homeDir: string): string {
  return path.join(homeDir, '.codex', CODEX_QUOTA_FILE_NAME)
}

/** `node` tem o formato do evento `rate_limits` (tem as chaves `primary` E
 * `secondary`, mesmo que uma delas seja `null`)? Checagem estrutural, não de
 * tipo — o `unknown` vem de JSON.parse de uma linha de stdout externa. */
function isRateLimitsShape(node: unknown): node is CodexRateLimitsEvent {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false
  const obj = node as Record<string, unknown>
  return 'primary' in obj && 'secondary' in obj
}

/** Busca recursiva (profundidade limitada) pelo evento `rate_limits` dentro
 * de uma linha JSONL já parseada. Cobre tanto a chave `rate_limits`
 * aninhada num envelope (ex.: `{"msg":{"type":"...","rate_limits":{...}}}`)
 * quanto o objeto já vir "solto" na raiz da linha — sem hardcodar um shape
 * específico de envelope. Profundidade limitada (JSON não tem ciclos, mas
 * uma linha maliciosa/gigante não deve travar o parse). */
function findRateLimitsNode(node: unknown, depth: number): CodexRateLimitsEvent | null {
  if (depth > 8 || node == null || typeof node !== 'object') return null
  if (!Array.isArray(node)) {
    const obj = node as Record<string, unknown>
    if ('rate_limits' in obj && isRateLimitsShape(obj['rate_limits'])) {
      return obj['rate_limits'] as CodexRateLimitsEvent
    }
    if (isRateLimitsShape(obj)) return obj
  }
  const children = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>)
  for (const child of children) {
    const found = findRateLimitsNode(child, depth + 1)
    if (found) return found
  }
  return null
}

/**
 * Acha e parseia o evento `rate_limits` no stdout JSONL do `codex exec
 * --json` (chamado pelo warmup em model-catalog.ts, nunca aqui — este
 * módulo só parseia texto, não roda processo). Cada linha do stdout é um
 * evento JSON; linhas que não são JSON válido são ignoradas silenciosamente
 * (o `codex exec --json` mistura outros eventos no meio). Nunca lança —
 * devolve `null` se nenhuma linha tiver o evento. Formato real provado ao
 * vivo 21/07 (ver docs/operations/engine-collection-real-steps.md).
 */
export function parseCodexRateLimitsFromJsonl(output: string): CodexRateLimitsEvent | null {
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // Duas formas de a linha carregar o evento:
    //  (a) JSONL puro — a linha inteira é um JSON (formato que o `codex exec
    //      --json` PODERIA emitir, coberto por retrocompat).
    //  (b) Linha de trace do CLI — provado ao vivo 21/07 (ver
    //      docs/operations/engine-collection-real-steps.md, seção Codex): o
    //      evento `rate_limits` NÃO sai no stdout do `--json`; vem no STDERR,
    //      só com RUST_LOG=trace, numa mensagem WebSocket cujo formato é
    //      `<timestamp> TRACE tungstenite::protocol: Received message {JSON}`.
    //      O JSON está embutido no fim da linha — pegamos a partir do 1º `{`.
    for (const candidate of jsonCandidatesFromLine(trimmed)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(candidate)
      } catch {
        continue
      }
      const found = findRateLimitsNode(parsed, 0)
      if (found) return found
      // A COTA TAMBÉM VEM DENTRO DA RECUSA, e era jogada fora.
      //
      // Medido ao vivo em 30/08: com a conta em 100% usada, o servidor recusa o
      // turno com 429 ANTES de mandar o evento `rate_limits`. Sem evento, o
      // leitor devolvia nulo — ou seja, o produto ficava cego exatamente no
      // momento em que a cota acabou, que é quando ele mais precisa enxergar.
      //
      // Mas o número da verdade está na própria recusa, nos cabeçalhos
      // `X-Codex-Primary-Used-Percent` e `X-Codex-Primary-Reset-At`. Ler dali
      // não é remendo: é a mesma informação, pela porta que sobrou aberta.
      const doTeto = rateLimitsDaRecusa(parsed)
      if (doTeto) return doTeto
    }
  }
  return null
}

/** Cabeçalhos que o servidor manda junto com a recusa por teto de conta. */
interface CabecalhosDeRecusa {
  'X-Codex-Primary-Used-Percent'?: string
  'X-Codex-Primary-Window-Minutes'?: string
  'X-Codex-Primary-Reset-At'?: string
  'X-Codex-Secondary-Used-Percent'?: string
}

/**
 * A cota que vem embutida numa recusa 429 por teto de conta.
 *
 * Devolve `null` para qualquer outra coisa — inclusive para uma recusa sem os
 * cabeçalhos: sem número, é melhor nulo honesto do que um zero inventado.
 */
export function rateLimitsDaRecusa(parsed: unknown): CodexRateLimitsEvent | null {
  if (!parsed || typeof parsed !== 'object') return null
  const raiz = parsed as Record<string, unknown>
  const status = raiz['status_code']
  if (status !== 429) return null

  const headers = raiz['headers']
  if (!headers || typeof headers !== 'object') return null
  const h = headers as CabecalhosDeRecusa

  const usado = Number(h['X-Codex-Primary-Used-Percent'])
  if (!Number.isFinite(usado)) return null

  const janelaEmMinutos = Number(h['X-Codex-Primary-Window-Minutes'])
  const resetEm = Number(h['X-Codex-Primary-Reset-At'])

  return {
    primary: {
      used_percent: usado,
      ...(Number.isFinite(janelaEmMinutos) ? { window_minutes: janelaEmMinutos } : {}),
      ...(Number.isFinite(resetEm) ? { reset_at: resetEm } : {}),
    },
    // A janela secundária pode não vir na recusa; nulo é a resposta honesta.
    secondary: Number.isFinite(Number(h['X-Codex-Secondary-Used-Percent']))
      ? { used_percent: Number(h['X-Codex-Secondary-Used-Percent']) }
      : null,
  } as CodexRateLimitsEvent
}

/** Candidatos de JSON numa linha: a linha inteira (JSONL puro) e, se ela tiver
 * texto antes do JSON (linha de trace `... Received message {…}`), o trecho a
 * partir do 1º `{`. Ordem: mais específico (embutido) não importa — os dois são
 * tentados; o primeiro que parseia e casa o shape vence. */
function jsonCandidatesFromLine(line: string): string[] {
  const candidates = [line]
  const brace = line.indexOf('{')
  if (brace > 0) candidates.push(line.slice(brace))
  return candidates
}

/** Achata o evento `rate_limits` pro formato gravado em disco (`CodexQuotaFile`).
 * Pura e testável — separada de `writeCodexQuotaFile` (I/O) de propósito. */
export function toCodexQuotaFile(event: CodexRateLimitsEvent): CodexQuotaFile {
  return {
    used_percent: event.primary?.used_percent ?? null,
    window_minutes: event.primary?.window_minutes ?? null,
    reset_at: event.primary?.reset_at ?? null,
    secondary: event.secondary
      ? {
          used_percent: event.secondary.used_percent ?? null,
          window_minutes: event.secondary.window_minutes ?? null,
          reset_at: event.secondary.reset_at ?? null,
        }
      : null,
  }
}

/**
 * Grava `~/.codex/gitorch-quota.json` a partir do evento `rate_limits`
 * extraído do stdout do warmup (chamada por `defaultCodexWarmUp` em
 * model-catalog.ts, logo após o ÚNICO `codex exec --json` do fluxo — nunca
 * rodamos `codex exec` duas vezes). Cria `~/.codex` se ainda não existir
 * (pode ser a primeira escrita do CLI naquele HOME). Deixa o erro subir pro
 * chamador decidir (best-effort é responsabilidade de quem chama, igual ao
 * resto do warmup) — nunca lançamos aqui por conta própria além do que o
 * `fs` já lança.
 */
export async function writeCodexQuotaFile(
  homeDir: string,
  event: CodexRateLimitsEvent
): Promise<void> {
  const file = codexQuotaFilePath(homeDir)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(toCodexQuotaFile(event)), 'utf8')
}

/**
 * Codex: lê `~/.codex/gitorch-quota.json`, gravado pelo warmup
 * (`defaultCodexWarmUp` em model-catalog.ts) a partir do evento
 * `rate_limits` do `codex exec --json`. SUBSTITUI a leitura de
 * `~/.codex/usage.json` (removida 21/07 — esse arquivo nunca existe, ver
 * comentário do bloco acima).
 *
 * Mapeia pro QuotaReading reaproveitando os campos criados pro Claude (ver
 * comentário de QuotaReading no topo do arquivo): `primary` (janela semanal,
 * `window_minutes` 10080) -> `weekPercentUsed`/`weekResetsAt`; `secondary`
 * (janela curta ~5h, só existe em planos pagos — `null` no free do dono) ->
 * `sessionPercentUsed`/`sessionResetsAt`. `remaining`/`total` continuam
 * `null` — o Codex não expõe saldo, nunca inventamos um número.
 *
 * `reset_at` (unix, segundos) é convertido com `resetToIso` — MESMO formato
 * (ISO string) que o Claude já usa, para o front tratar os dois de forma
 * uniforme.
 *
 * Sem o arquivo (warmup nunca rodou ou falhou) ou JSON inválido/corrompido
 * -> `EMPTY_CODEX_QUOTA` (tudo null), nunca lança — mesmo contrato
 * best-effort do resto do arquivo.
 */
export const readCodexQuota: QuotaReader = async (homeDir: string) => {
  const env = envReading('codex')
  if (env) return env
  const raw = await fs.readFile(codexQuotaFilePath(homeDir), 'utf8').catch(() => null)
  if (!raw) return EMPTY_CODEX_QUOTA
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_CODEX_QUOTA
  }
  if (!parsed || typeof parsed !== 'object') return EMPTY_CODEX_QUOTA
  const file = parsed as Partial<CodexQuotaFile>
  const secondary = file.secondary ?? null
  return {
    remaining: null,
    total: null,
    weekPercentUsed: numberish(file.used_percent),
    weekResetsAt: resetToIso(file.reset_at != null ? String(file.reset_at) : null),
    sessionPercentUsed: secondary ? numberish(secondary.used_percent) : null,
    sessionResetsAt: secondary
      ? resetToIso(secondary.reset_at != null ? String(secondary.reset_at) : null)
      : null,
  }
}

/** Objeto mínimo compatível com `Response.headers` (Fetch API) — só o `.get()`
 *  que os parsers abaixo usam. Aceita tanto o `Headers` real do fetch quanto
 *  um fake de teste. */
export interface HeaderReader {
  get(name: string): string | null
}

/**
 * Converte uma utilization (fração 0..1, como a API manda) em percentual
 * inteiro (0..100). `0.99` -> `99`. Header ausente ou não-numérico -> null,
 * nunca NaN.
 */
function utilizationToPercent(raw: string | null): number | null {
  if (raw == null) return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

/** Converte um reset unix (segundos, como a API manda) em ISO string. Header
 *  ausente ou não-numérico -> null, nunca uma data inválida. */
function resetToIso(raw: string | null): string | null {
  if (raw == null) return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  const date = new Date(n * 1000)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

/**
 * Extrai a quota do Claude dos HEADERS de rate limit da API pública da
 * Anthropic (qualquer resposta de `/v1/messages`, sucesso OU erro — a
 * Anthropic manda esses headers nos dois casos):
 *
 *   anthropic-ratelimit-unified-5h-utilization  (fração 0..1) + -5h-reset (unix)
 *   anthropic-ratelimit-unified-7d-utilization  (fração 0..1) + -7d-reset (unix)
 *
 * Substitui `parseClaudeUsageText` (removida 21/07): aquele parser lia texto
 * de `claude -p "/usage"`, que NUNCA funcionou com o token que o produto
 * captura (`claude setup-token`, escopo `user:inference` — devolve só um
 * resumo de sessão zerado, provado ao vivo). Estes headers vêm da MESMA
 * chamada que já autentica com esse token (ver makeClaudeQuotaReader),
 * refletindo o estado real da conta no servidor. Ver
 * docs/operations/engine-collection-real-steps.md (privado).
 */
export function parseClaudeRateLimitHeaders(headers: HeaderReader): QuotaReading {
  return {
    remaining: null,
    total: null,
    sessionPercentUsed: utilizationToPercent(
      headers.get('anthropic-ratelimit-unified-5h-utilization')
    ),
    sessionResetsAt: resetToIso(headers.get('anthropic-ratelimit-unified-5h-reset')),
    weekPercentUsed: utilizationToPercent(
      headers.get('anthropic-ratelimit-unified-7d-utilization')
    ),
    weekResetsAt: resetToIso(headers.get('anthropic-ratelimit-unified-7d-reset')),
  }
}

// Modelo mais barato disponível pra sondar a quota — a chamada só serve pra
// ler os HEADERS de rate limit da resposta, o corpo (1 token de saída) é
// descartado. Custo desprezível por leitura.
const CLAUDE_QUOTA_PROBE_MODEL = 'claude-haiku-4-5-20251001'

/**
 * Claude: sonda a quota fazendo um `POST /v1/messages` mínimo (max_tokens: 1)
 * na API pública da Anthropic, autenticado com o token que `claude
 * setup-token` gera (lido do homeDir por `readClaudeTokenFromHome`) — e lê o
 * resultado dos HEADERS da resposta (`parseClaudeRateLimitHeaders`), não do
 * corpo. Prova ao vivo 21/07 (docs/operations/engine-collection-real-steps.md):
 * 5h ≈ 99% usado, semana ≈ 40% usado.
 *
 * Override por ambiente (GITORCH_CLAUDE_QUOTA_REMAINING/TOTAL) vence e evita
 * qualquer chamada de rede — mesmo contrato de antes/do Antigravity.
 * `fetchImpl`/`readToken` injetáveis (DI) — nenhum teste bate rede real.
 * Sem token no homeDir, ou qualquer erro de rede/timeout: cai no
 * EMPTY_CLAUDE_QUOTA (tudo null), nunca lança. Uma resposta não-ok (ex.: 429
 * por estourar a quota) ainda tem os headers de rate limit — não descartamos
 * o dado só por causa do status.
 */
export function makeClaudeQuotaReader(
  fetchImpl: typeof fetch = fetch,
  readToken: (homeDir: string) => Promise<string | null> = readClaudeTokenFromHome
): QuotaReader {
  return async (homeDir: string) => {
    const env = envReading('claude')
    if (env) return env
    const token = await readToken(homeDir)
    if (!token) return EMPTY_CLAUDE_QUOTA
    try {
      const res = await fetchImpl(`${CLAUDE_API_BASE}/v1/messages`, {
        method: 'POST',
        headers: {
          ...claudeApiHeaders(token),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: CLAUDE_QUOTA_PROBE_MODEL,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        signal: AbortSignal.timeout(CLAUDE_API_TIMEOUT_MS),
      })
      return parseClaudeRateLimitHeaders(res.headers)
    } catch (err) {
      console.warn('[quota-reader] POST /v1/messages falhou — quota do Claude nula', {
        error: err instanceof Error ? err.message : String(err),
      })
      return EMPTY_CLAUDE_QUOTA
    }
  }
}

/** Instância real usada em produção (QUOTA_READERS.claude) — chama a API de
 *  verdade via fetch global. */
export const readClaudeQuota: QuotaReader = makeClaudeQuotaReader()

export const QUOTA_READERS: Record<string, QuotaReader> = {
  antigravity: readAntigravityQuota,
  codex: readCodexQuota,
  claude: readClaudeQuota,
}
