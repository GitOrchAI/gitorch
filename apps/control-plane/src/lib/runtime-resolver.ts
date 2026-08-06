import { isF6AgentRole, isF6AgentRuntime, type F6AgentRole } from '@gitorch/agents'

// Resolve, por projeto e por agente, qual motor+modelo usar e a cadeia de
// fallback. A escolha vive em project.runtimeConfig.agents (dado do cliente);
// na ausência, cai nos padrões da instância. Nunca hardcode de motor no fluxo.

export interface RuntimeSelection {
  runtime: string
  model?: string
}

interface AgentRuntimePref {
  runtime?: string
  model?: string
  fallbacks?: Array<{ runtime: string; model?: string }>
}

export interface ResolverDefaults {
  /** Motor padrão por papel quando o projeto não define. */
  runtimeByRole: Record<F6AgentRole, string>
  /** Modelo padrão por papel. */
  modelByRole: Record<F6AgentRole, string>
}

function readAgentsConfig(runtimeConfig: unknown): Record<string, AgentRuntimePref> {
  if (!runtimeConfig || typeof runtimeConfig !== 'object') return {}
  const agents = (runtimeConfig as { agents?: unknown }).agents
  if (!agents || typeof agents !== 'object') return {}
  return agents as Record<string, AgentRuntimePref>
}

/**
 * Cadeia de seleção (primária + fallbacks) para um papel. A primeira é a
 * preferida; as demais são tentadas em ordem se a primária falhar/estourar cota.
 * Entradas com runtime inválido são descartadas; garante ao menos o default.
 */
export function resolveRuntimeChain(
  role: F6AgentRole,
  runtimeConfig: unknown,
  defaults: ResolverDefaults
): RuntimeSelection[] {
  const pref = readAgentsConfig(runtimeConfig)[role] ?? {}
  const chain: RuntimeSelection[] = []

  const push = (runtime?: string, model?: string) => {
    if (!runtime || !isF6AgentRuntime(runtime)) return
    if (chain.some((c) => c.runtime === runtime)) return // sem duplicar motor
    chain.push(model ? { runtime, model } : { runtime })
  }

  push(pref.runtime, pref.model)
  for (const fb of pref.fallbacks ?? []) push(fb.runtime, fb.model)

  // Garante o motor padrão do papel na cadeia (nunca fica vazia).
  push(defaults.runtimeByRole[role], defaults.modelByRole[role])

  // Preenche o modelo padrão quando a preferência não trouxe um.
  return chain.map((sel) =>
    sel.model ? sel : { runtime: sel.runtime, model: defaults.modelByRole[role] }
  )
}

/** Conveniência: só a seleção primária. */
export function resolvePrimaryRuntime(
  role: string,
  runtimeConfig: unknown,
  defaults: ResolverDefaults
): RuntimeSelection {
  const safeRole: F6AgentRole = isF6AgentRole(role) ? role : 'ra'
  return resolveRuntimeChain(safeRole, runtimeConfig, defaults)[0] as RuntimeSelection
}

// Erros que justificam trocar de motor (cota esgotada, rate limit, auth). Erros
// de conteúdo do repositório de terceiros NÃO devem disparar failover às cegas.
//
// E2BIG (achado importante): o prompt vira um único argumento de linha de
// comando e o Linux limita cada argumento (e o total de argv+env) a ~128 KiB.
// Em repositório grande — o alvo declarado do produto — a missão morria com
// `spawn E2BIG` e, sem este padrão, NENHUM failover era tentado: o próximo
// motor da cadeia do cliente nunca era acionado por um erro que é do
// processo local, não do motor. Isso some junto com o teto de tamanho de
// prompt em runtime-adapter.ts (capPromptForArgv) — o teto reduz a chance de
// E2BIG acontecer; isFailoverError cobre o que ainda passar (ex.: um
// argumento de outra origem, ou um SO com ARG_MAX menor).
const FAILOVER_PATTERN =
  /quota|rate.?limit|429|exhaust|insufficient|unauthor|forbidden|\b401\b|\b403\b|invalid.?api.?key|e2big|argument list too long/i

export function isFailoverError(message: string): boolean {
  return FAILOVER_PATTERN.test(message)
}
