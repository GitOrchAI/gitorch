import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Leitura DINÂMICA da quota restante por motor (BYOK). Espelha o padrão do
// model-catalog: cada motor lê de um jeito próprio; nada hardcoded. Best-effort:
// se o motor não expõe quota, devolve { remaining: null } e o spend-guard trata
// como 'unknown' (não bloqueia). Sempre dá pra sobrescrever por ambiente.

export interface QuotaReading {
  remaining: number | null
  total: number | null
  // Claude (`claude -p "/usage"`, ver parseClaudeUsageText/makeClaudeQuotaReader
  // abaixo): a CLI não devolve um saldo remaining/total — devolve % USADO de
  // DUAS janelas independentes (sessão de ~5h corridas e semana, todos os
  // modelos) mais o horário de reset de cada uma. Forçar isso no formato
  // remaining/total inventaria um número que não existe — por isso campos
  // NOVOS e opcionais, só o Claude os popula. Codex/Antigravity continuam só
  // em remaining/total; estes ficam undefined/null pra eles, sem regressão.
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

/**
 * Extrai as duas linhas relevantes de `claude -p "/usage"`:
 *
 *   Current session: 100% used · resets Jul 21, 3:09am (UTC)
 *   Current week (all models): 41% used · resets Jul 26, 5:59pm (UTC)
 *
 * Essas 2 linhas refletem o estado da CONTA no servidor da Anthropic (janela
 * rolante de sessão ~5h, semanal pros modelos) — é o dado real que o roteiro
 * original pedia ("quotas coletadas no login"). O texto que vem DEPOIS
 * ("What's contributing to your limits usage?") é histórico LOCAL desta
 * máquina (não inclui outros dispositivos nem claude.ai) — inútil pra uma
 * conexão nova (homeDir efêmero sem sessões locais) e ignorado de propósito:
 * esta função nunca olha além das linhas "Current session"/"Current week".
 *
 * Tolerante a variação de espaçamento/pontuação (é texto humano, não JSON):
 * não trava em formatação exata — procura "current session"/"current week"
 * em qualquer linha (case-insensitive) e extrai só o percentual e o texto
 * depois de "resets". Linha ausente ou sem percentual reconhecível -> null
 * nos campos daquela janela, nunca lança.
 */
export function parseClaudeUsageText(text: string): QuotaReading {
  const lines = text.split(/\r?\n/)
  const sessionLine = lines.find((l) => /current\s+session/i.test(l))
  const weekLine = lines.find((l) => /current\s+week/i.test(l))
  return {
    remaining: null,
    total: null,
    sessionPercentUsed: sessionLine ? extractUsagePercent(sessionLine) : null,
    sessionResetsAt: sessionLine ? extractResetsAt(sessionLine) : null,
    weekPercentUsed: weekLine ? extractUsagePercent(weekLine) : null,
    weekResetsAt: weekLine ? extractResetsAt(weekLine) : null,
  }
}

function extractUsagePercent(line: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(line)
  return m?.[1] ? Number(m[1]) : null
}

function extractResetsAt(line: string): string | null {
  const m = /resets?\b[:\-]?\s*(.+?)\s*$/i.exec(line)
  return m?.[1]?.trim() || null
}

/**
 * Claude: `claude -p "/usage"` (best-effort; DI de runner — reusa o mesmo
 * `defaultRunner` do Antigravity/execFileAsync, mesmo padrão do resto do
 * arquivo). Override por ambiente (GITORCH_CLAUDE_QUOTA_REMAINING/TOTAL)
 * vence e evita qualquer spawn — mesmo contrato do Antigravity. Runner
 * falhando (binário ausente, timeout, exit != 0) nunca lança: cai no
 * EMPTY_CLAUDE_QUOTA (tudo null).
 */
export function makeClaudeQuotaReader(
  claudeBin = process.env['GITORCH_CLAUDE_BIN'] ?? 'claude',
  args = (process.env['GITORCH_CLAUDE_QUOTA_CMD'] ?? '-p /usage').split(' '),
  runner: (bin: string, args: string[], home: string) => Promise<string> = defaultRunner
): QuotaReader {
  return async (homeDir: string) => {
    const env = envReading('claude')
    if (env) return env
    try {
      return parseClaudeUsageText(await runner(claudeBin, args, homeDir))
    } catch {
      return EMPTY_CLAUDE_QUOTA
    }
  }
}

/** Instância real usada em produção (QUOTA_READERS.claude) — roda o binário
 *  de verdade via defaultRunner. */
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
