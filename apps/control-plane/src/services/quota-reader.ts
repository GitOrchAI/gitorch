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
}

export type QuotaReader = (homeDir: string) => Promise<QuotaReading>

const UNKNOWN: QuotaReading = { remaining: null, total: null }

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

/** Claude: sem leitura simples da CLI; só por ambiente. */
export const readClaudeQuota: QuotaReader = async () => envReading('claude') ?? UNKNOWN

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
