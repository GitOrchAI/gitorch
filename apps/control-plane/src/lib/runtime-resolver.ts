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
  defaults: ResolverDefaults,
  /**
   * Os motores que o cliente TEM conectados agora, como última reserva.
   *
   * MEDIDO AO VIVO em 26/08: numa corrida real, o RA morreu com "Individual
   * quota reached... Resets in 18h43m26s" e a esteira parou ali. Havia outro
   * motor conectado e ocioso ao lado — mas a cadeia tinha um só, então o
   * failover que já existe não tinha para onde ir. A cota de um motor derrubou
   * os quatro papéis por dezoito horas.
   *
   * Entram DEPOIS da escolha do cliente e dos fallbacks dele: quem escolheu um
   * motor de propósito continua com ele em primeiro lugar. A reserva não muda
   * a preferência de ninguém — ela só existe para o dia em que a preferência
   * não pode rodar.
   */
  motoresConectados: readonly string[] = []
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

  // E, por último, o que o cliente tem conectado. Sem isto, um projeto que
  // escolheu um motor só fica sem reserva no dia em que ele estoura a cota.
  for (const runtime of motoresConectados) push(runtime)

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
// "usage limit" entrou em 27/08 depois de uma medição na mão: o Codex diz
// "You've hit your usage limit", que NÃO casava com nenhum dos padrões acima —
// nem "quota", nem "rate limit", nem 429. O Antigravity, que diz "Individual
// quota reached", casava. A mesma situação era tratada de dois jeitos por
// acaso de vocabulário, e no caso do Codex a troca de motor nem era tentada
// pelo texto (só pelo tipo do erro, quando havia um).
// "sem credencial conectada" entrou em 31/08 pelo mesmo motivo de "usage
// limit": é uma falha de AUTENTICAÇÃO do motor — a mais clara de todas, porque
// o produto a constata ANTES de disparar (ver SemCredencialDoMotorError) — e
// sem este padrão ela não seria reconhecida como motivo de trocar de motor,
// e um motor desconectado mataria a missão em vez de passá-la para a reserva.
const FAILOVER_PATTERN =
  /quota|rate.?limit|429|exhaust|insufficient|unauthor|forbidden|\b401\b|\b403\b|invalid.?api.?key|e2big|argument list too long|usage limit|sem credencial conectada/i

export function isFailoverError(message: string): boolean {
  return FAILOVER_PATTERN.test(message)
}
