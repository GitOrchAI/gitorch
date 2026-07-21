import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  readClaudeTokenFromHome,
  CLAUDE_API_BASE,
  CLAUDE_API_TIMEOUT_MS,
  claudeApiHeaders,
} from './claude-token.js'

const execFileAsync = promisify(execFile)

// Leitura DINÂMICA da quota restante por motor (BYOK). Espelha o padrão do
// model-catalog: cada motor lê de um jeito próprio; nada hardcoded. Best-effort:
// se o motor não expõe quota, devolve { remaining: null } e o spend-guard trata
// como 'unknown' (não bloqueia). Sempre dá pra sobrescrever por ambiente.

export interface QuotaReading {
  remaining: number | null
  total: number | null
  // Claude (ver parseClaudeRateLimitHeaders/makeClaudeQuotaReader abaixo): a
  // API não devolve um saldo remaining/total — devolve % USADO de DUAS
  // janelas independentes (sessão rolante de ~5h e semana, todos os modelos)
  // mais o horário de reset de cada uma, nos HEADERS de qualquer resposta de
  // POST /v1/messages. Forçar isso no formato remaining/total inventaria um
  // número que não existe — por isso campos NOVOS e opcionais, só o Claude os
  // popula. Codex/Antigravity continuam só em remaining/total; estes ficam
  // undefined/null pra eles, sem regressão.
  sessionPercentUsed?: number | null
  sessionResetsAt?: string | null
  weekPercentUsed?: number | null
  weekResetsAt?: string | null
}

export type QuotaReader = (homeDir: string) => Promise<QuotaReading>

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

function numberish(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v.replace(/[,_\s]/g, ''))
    return Number.isFinite(n) ? n : null
  }
  return null
}

function matchNumber(text: string, re: RegExp): number | null {
  const m = re.exec(text)
  if (!m || !m[1]) return null
  const n = Number(m[1].replace(/[,_\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

/** Override por ambiente: GITORCH_<RUNTIME>_QUOTA_REMAINING / _TOTAL. */
function envReading(runtime: string): QuotaReading | null {
  const up = runtime.toUpperCase()
  const remaining = numberish(process.env[`GITORCH_${up}_QUOTA_REMAINING`])
  const total = numberish(process.env[`GITORCH_${up}_QUOTA_TOTAL`])
  if (remaining == null && total == null) return null
  return { remaining, total }
}

/** Antigravity: `agy usage` (best-effort; parse texto/JSON). */
export function makeAntigravityQuotaReader(
  agyBin = process.env['GITORCH_AGY_BIN'] ?? 'agy',
  subcommand = (process.env['GITORCH_AGY_QUOTA_CMD'] ?? 'usage').split(' '),
  runner: (bin: string, args: string[], home: string) => Promise<string> = defaultRunner
): QuotaReader {
  return async (homeDir: string) => {
    const env = envReading('antigravity')
    if (env) return env
    try {
      return parseQuotaText(await runner(agyBin, subcommand, homeDir))
    } catch {
      return UNKNOWN
    }
  }
}

/** Codex: lê ~/.codex/usage.json se existir (best-effort). */
export const readCodexQuota: QuotaReader = async (homeDir: string) => {
  const env = envReading('codex')
  if (env) return env
  const file = path.join(homeDir, '.codex', 'usage.json')
  const raw = await fs.readFile(file, 'utf8').catch(() => null)
  if (!raw) return UNKNOWN
  return parseQuotaText(raw)
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
  antigravity: makeAntigravityQuotaReader(),
  codex: readCodexQuota,
  claude: readClaudeQuota,
}

async function defaultRunner(bin: string, args: string[], home: string): Promise<string> {
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: home }
  if (process.env['XDG_RUNTIME_DIR']) env['XDG_RUNTIME_DIR'] = process.env['XDG_RUNTIME_DIR']
  const pending = execFileAsync(bin, args, { env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  pending.child.stdin?.end()
  const { stdout } = await pending
  return stdout
}
