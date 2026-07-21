// Módulo-FOLHA (sem imports de quota-reader.ts nem de
// antigravity-quota-reader.ts): tipos + helper de override por ambiente
// COMPARTILHADOS pelos dois. Extraído (21/07) de propósito pra fora de
// quota-reader.ts — antigravity-quota-reader.ts precisa do MESMO
// QuotaReading/envReading, e quota-reader.ts importa `readAntigravityQuota`
// de antigravity-quota-reader.ts (pra popular QUOTA_READERS.antigravity). Um
// import circular DIRETO entre os dois (cada um importando o outro)
// quebraria em tempo de execução dependendo de qual dos dois módulos fosse
// carregado primeiro pela aplicação: o `const` do lado ainda não executado
// fica em temporal-dead-zone even com ESM live-bindings, e o primeiro a
// tentar LER esse valor (não só referenciar o tipo) lançaria
// `ReferenceError: Cannot access '...' before initialization`. Um módulo-
// folha comum embaixo dos dois evita o ciclo inteiramente.

export interface QuotaReading {
  remaining: number | null
  total: number | null
  // Claude/Codex/Antigravity (ver os readers de cada um): a API/CLI não
  // devolve um saldo remaining/total pra estes três — devolve % USADO de
  // janelas independentes (sessão ~5h e semana) mais o horário de reset de
  // cada uma. Forçar isso no formato remaining/total inventaria um número
  // que não existe — por isso campos NOVOS e opcionais.
  sessionPercentUsed?: number | null
  sessionResetsAt?: string | null
  weekPercentUsed?: number | null
  weekResetsAt?: string | null
}

export type QuotaReader = (homeDir: string) => Promise<QuotaReading>

/** Converte string/number "sujo" (vírgulas, underscores, espaços) num
 * number finito, ou `null` — nunca NaN. Usado por todos os parsers de quota
 * (texto solto, JSON, override de ambiente). */
export function numberish(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v.replace(/[,_\s]/g, ''))
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Override por ambiente: GITORCH_<RUNTIME>_QUOTA_REMAINING / _TOTAL. Vence
 * qualquer leitura real (API/CLI/PTY) — mesmo contrato pros 3 motores. */
export function envReading(runtime: string): QuotaReading | null {
  const up = runtime.toUpperCase()
  const remaining = numberish(process.env[`GITORCH_${up}_QUOTA_REMAINING`])
  const total = numberish(process.env[`GITORCH_${up}_QUOTA_TOTAL`])
  if (remaining == null && total == null) return null
  return { remaining, total }
}
