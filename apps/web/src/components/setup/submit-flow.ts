// Fluxo de fechamento do setup wizard — submit e checkout, puros e agnósticos de
// framework (mesma decisão de engine-status.ts: o app web não tem
// jsdom/testing-library, então a lógica que precisa de teste fica FORA do React).
//
// A REGRA DE OURO deste arquivo: QUEM PAGA NUNCA PERDE A CHAVE.
//
// A chave de API em texto puro existe UMA ÚNICA VEZ: no corpo da resposta de
// POST /api/v1/setup/submit. O banco guarda só o bcrypt hash dela
// (apps/control-plane/src/routes/setup.ts) — de propósito, para que um dump do
// banco não renda credencial usável. Consequência direta: se o cliente sair da
// tela sem copiar a chave, ela some para sempre. Não há rota, consulta nem
// suporte que a recupere.
//
// Por isso o submit aqui NÃO conhece pagamento. Ele devolve os projetos (com a
// chave) para quem vai renderizá-los, e ponto. O checkout é um passo separado e
// posterior, disparado só depois que a chave já está na tela do cliente, com o
// aviso de que é a única exibição. Inverter essa ordem — como já esteve — jogava
// o cliente pagante direto pro Stripe e queimava a credencial dele.

export interface CreatedProject {
  id: string
  name: string
  wingId: string
  apiKey: string
}

// Contrato mínimo de resposta HTTP: o suficiente para o fluxo e para um fake nos
// testes, sem arrastar a interface inteira de Response.
export interface HttpResponse {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<HttpResponse>

const defaultFetcher: Fetcher = (url, init) => fetch(url, init)

// Único ponto do funil que decide "isto é pago". Plano vazio ou desconhecido NÃO
// cobra: na dúvida, o cliente não é jogado num checkout que ele não pediu.
export function isPaidPlan(plan: string): boolean {
  const p = plan.trim().toLowerCase()
  return p !== '' && p !== 'free'
}

// Parse defensivo do corpo do submit (mesmo estilo de parseSetupStatus): payload
// torto vira lista vazia, não uma tela quebrada com `projects.map` de undefined.
export function parseCreatedProjects(json: unknown): CreatedProject[] {
  const body = (json ?? {}) as { projects?: unknown }
  if (!Array.isArray(body.projects)) return []
  return body.projects.filter((p): p is CreatedProject => {
    const c = (p ?? {}) as Record<string, unknown>
    return (
      typeof c['id'] === 'string' &&
      typeof c['name'] === 'string' &&
      typeof c['wingId'] === 'string' &&
      typeof c['apiKey'] === 'string' &&
      c['apiKey'] !== ''
    )
  })
}

// Sem `telegram`: o @username que este submit carregava era gravado em
// runtimeConfig/payload e ninguém lia — nem poderia, já que o Telegram endereça
// por chat_id, não por @username. O vínculo real tem rota e tabela próprias
// (setup/telegram/link -> /start -> telegram_links). Ver ./telegram-link.ts.
export interface SubmitInput {
  apiBaseUrl: string
  plan: string
  repos: string[]
  engines: string[]
  /**
   * Até onde o cliente deixa o GitOrch ir no repositório dele:
   * 'so_olhar' | 'sugerir' | 'cuidar'.
   *
   * Decisão do dono (29/08): a pergunta é feita AQUI, no assistente — plugar o
   * repositório não é, sozinho, autorização para escrever nele. Ausente, o
   * servidor usa o nível mais restrito.
   */
  autonomia?: string
}

export interface SubmitDeps {
  fallbackError: string
  fetchImpl?: Fetcher
}

/**
 * Cria o projeto e devolve as credenciais recém-nascidas. Não redireciona, não
 * cobra, não fala com o Stripe: a única saída daqui é a lista de projetos (com a
 * chave em claro) indo para a memória do React, que a renderiza no passo final.
 *
 * Um sucesso sem projeto nenhum é tratado como FALHA de propósito — "tudo pronto"
 * sem chave nenhuma na tela seria uma mentira, e o cliente sairia sem credencial
 * achando que deu certo.
 */
export async function submitSetup(input: SubmitInput, deps: SubmitDeps): Promise<CreatedProject[]> {
  const doFetch = deps.fetchImpl ?? defaultFetcher
  const response = await doFetch(`${input.apiBaseUrl}/api/v1/setup/submit`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repos: input.repos,
      engines: input.engines,
      plan: input.plan,
      // Só vai quando o cliente escolheu. Mandar um valor "padrão" daqui
      // apagaria a diferença entre "ele escolheu só olhar" e "ele não
      // escolheu nada" — e o servidor precisa dessa diferença para saber se
      // pergunta a ele ou não.
      ...(input.autonomia ? { autonomia: input.autonomia } : {}),
    }),
  })

  if (!response.ok) {
    const errBody = (await response.json().catch(() => ({}))) as { error?: unknown }
    const message = typeof errBody.error === 'string' && errBody.error.trim() ? errBody.error : ''
    throw new Error(message || deps.fallbackError)
  }

  const projects = parseCreatedProjects(await response.json())
  if (projects.length === 0) throw new Error(deps.fallbackError)
  return projects
}

// Resultado do checkout. `at_capacity` é o 402 do backend (infra no teto → o
// cliente vai pra waitlist): merece texto próprio, não pode ser engolido como
// "erro genérico" — que era o que acontecia antes (o catch silencioso).
export type CheckoutOutcome =
  { ok: true; url: string } | { ok: false; reason: 'at_capacity' | 'failed' }

export interface CheckoutInput {
  apiBaseUrl: string
  plan: string
  // País vem da detecção por IP (lib/geo) — define a moeda/faixa no Stripe.
  country: string | undefined
}

/**
 * Abre a Checkout Session e devolve a URL do Stripe. Repare no que esta função
 * NÃO recebe: a chave de API. O segredo do cliente não tem por que existir aqui,
 * então ele não pode vazar daqui — nem na URL (histórico do navegador, logs,
 * header Referer enviado ao Stripe), nem no corpo.
 *
 * Chamada só DEPOIS que a chave já foi exibida e reconhecida pelo cliente.
 */
export async function startCheckout(
  input: CheckoutInput,
  deps: { fetchImpl?: Fetcher } = {}
): Promise<CheckoutOutcome> {
  const doFetch = deps.fetchImpl ?? defaultFetcher
  const qs = input.country ? `?country=${encodeURIComponent(input.country)}` : ''
  try {
    const response = await doFetch(`${input.apiBaseUrl}/api/billing/checkout${qs}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: input.plan }),
    })

    if (response.status === 402) return { ok: false, reason: 'at_capacity' }
    if (!response.ok) return { ok: false, reason: 'failed' }

    const body = (await response.json()) as { url?: unknown }
    if (typeof body.url === 'string' && body.url) return { ok: true, url: body.url }
    return { ok: false, reason: 'failed' }
  } catch {
    // Rede fora / Stripe fora. O cliente NÃO fica no prejuízo: o projeto e a
    // chave já existem, ele segue com o botão e a mensagem honesta na tela.
    return { ok: false, reason: 'failed' }
  }
}
