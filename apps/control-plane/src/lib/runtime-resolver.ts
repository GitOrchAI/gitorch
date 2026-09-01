import { isF6AgentRole, isF6AgentRuntime, type F6AgentRole } from '@gitorch/agents'

// Resolve, por projeto e por agente, qual motor+modelo usar e a cadeia de
// fallback. A escolha vive em project.runtimeConfig.agents (dado do cliente);
// na ausência, cai nos padrões da instância. Nunca hardcode de motor no fluxo.

export interface RuntimeSelection {
  runtime: string
  model?: string
  /**
   * O ESFORÇO daquele degrau, no vocabulário do MOTOR dele — nunca um nível
   * genérico nosso. Cada motor tem a sua escada e elas não coincidem:
   * claude aceita low|medium|high|xhigh|max, codex low|medium|high|xhigh, e o
   * antigravity não separa esforço de modelo (o nível vive dentro do nome,
   * `Gemini 3.7 Flash (High)`). Quem valida e quem traduz para a linha de
   * comando é `services/esforco-por-motor.ts`, onde está a medição de cada CLI.
   *
   * Opcional de propósito: um degrau que só tem `runtime` continua valendo
   * exatamente como antes desta mudança.
   */
  effort?: string
}

interface AgentRuntimePref {
  runtime?: string
  model?: string
  effort?: string
  fallbacks?: Array<{ runtime: string; model?: string; effort?: string }>
}

/**
 * Os padrões da INSTÂNCIA. Só motor: o MODELO padrão não mora mais aqui.
 *
 * Ele morava — `modelByRole`, um nome por papel — e era a mesma constante do
 * Antigravity aplicada a qualquer motor, ao lado de um `runtimeByRole` que diz
 * `codex`. O par nunca foi coerente, e ninguém tinha medido: em 01/09/2026,
 * `claude --model "Gemini 3.7 Flash (Medium)"` responde "There's an issue with
 * the selected model". O padrão de modelo é por PAPEL e por MOTOR, resolvido
 * contra o catálogo vivo daquele motor — ver services/padrao-do-degrau.ts.
 */
export interface ResolverDefaults {
  /** Motor padrão por papel quando o projeto não define. */
  runtimeByRole: Record<F6AgentRole, string>
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

  const push = (runtime?: string, model?: string, effort?: string) => {
    if (!runtime || !isF6AgentRuntime(runtime)) return
    if (chain.some((c) => c.runtime === runtime)) return // sem duplicar motor
    chain.push({
      runtime,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    })
  }

  push(pref.runtime, pref.model, pref.effort)
  for (const fb of pref.fallbacks ?? []) push(fb.runtime, fb.model, fb.effort)

  // Garante o motor padrão do papel na cadeia (nunca fica vazia). Sem modelo:
  // o do papel naquele motor sai do catálogo vivo, na etapa assíncrona.
  push(defaults.runtimeByRole[role])

  // E, por último, o que o cliente tem conectado. Sem isto, um projeto que
  // escolheu um motor só fica sem reserva no dia em que ele estoura a cota.
  for (const runtime of motoresConectados) push(runtime)

  // O MODELO NÃO É MAIS CARIMBADO AQUI, e isso é o conserto de um defeito
  // medido ao vivo em 01/09/2026.
  //
  // Antes, todo degrau sem modelo recebia `defaults.modelByRole[role]` — uma
  // constante só, escrita com nomes do Antigravity. Rodando
  // `resolveRuntimeChain('ra', null, padrões_reais, ['antigravity','claude',
  // 'codex'])` com o resolvedor compilado, os TRÊS degraus voltaram com
  // `Gemini 3.7 Flash (Medium)`. E:
  //
  //   $ claude --model "Gemini 3.7 Flash (Medium)" -p "say ok"
  //     [claude-code:unrecognized_model] ...
  //     There's an issue with the selected model.
  //
  // Os degraus de reserva nasciam mortos: o rodízio existia no papel e não
  // tinha para onde ir. Pior, o próprio padrão da instância era incoerente —
  // `runtimeByRole` diz `codex` e `modelByRole` diz um nome Gemini, um par que
  // nenhum dos dois motores aceita.
  //
  // Um degrau sem `model` quer dizer "ainda não sei", nunca "rode qualquer
  // um". Quem responde é o padrão do PAPEL naquele MOTOR, resolvido contra o
  // catálogo VIVO daquele motor (services/padrao-do-degrau.ts), na etapa
  // assíncrona que já existe para conferir o catálogo. Um modelo aqui só
  // aparece quando o CLIENTE escolheu.
  return chain
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
