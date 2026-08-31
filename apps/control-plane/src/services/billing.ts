// Serviço de billing (Stripe, modo teste no lançamento). A lógica de DECISÃO
// (faixa, coerência anti-VPN, cap de capacidade) fica em funções puras/testáveis;
// as chamadas ao Stripe ficam finas. Ver docs/business/pricing-strategy.md.

// ATENCAO AO ATUALIZAR: a versao do stripe esta TRAVADA em 22.4.0 (exata, sem ^)
// nos package.json e reforcada em pnpm.overrides/overrides/resolutions na raiz.
// Motivo (31/08/2026): a 22.5.0 - changelog de 10/08/2026, stripe-node PR #2805
// "Emit Claude Code plugin hint at module load time" - escreve no stderr, ao
// carregar o modulo, a marcacao <claude-code-hint v="1" type="plugin"
// value="stripe@claude-plugins-official" /> quando detecta CLAUDECODE ou
// CLAUDE_CODE_CHILD_SESSION no ambiente. Essa marcacao imita a marcacao de
// controle interna da ferramenta do agente: e uma dependencia de terceiro
// injetando contexto no nosso agente, e nao ha como desligar por configuracao.
// A 22.6.0 (latest em 31/08/2026) AINDA TEM o mesmo trecho - "atualizar a
// dependencia velha" NAO resolve, reabre o buraco. Antes de mexer no pino,
// confira a versao nova com: grep -rn 'claude-code-hint' no pacote publicado.
import Stripe from 'stripe'
import type { PrismaClient } from '@prisma/client'
import { tierForCountry, cardTierIsCoherent, type PricingTier } from '../lib/geo-pricing.js'

let _stripe: Stripe | null = null

/** Cliente Stripe lazy. Lança se a chave não estiver no ambiente. */
export function getStripe(): Stripe {
  const key = process.env['STRIPE_SECRET_KEY']
  if (!key) throw new Error('STRIPE_SECRET_KEY ausente no ambiente')
  if (!_stripe) _stripe = new Stripe(key)
  return _stripe
}

// Teto de assinaturas ATIVAS que a infra atual aguenta (~10-20). Acima disso,
// novos pagantes entram na waitlist em vez de assinar (nunca vender o que não
// se entrega). Sobe quando a VM-MT-SaaS entrar.
export const ACTIVE_SUBSCRIPTION_CAP = Number(process.env['GITORCH_PAYING_CAP'] ?? '15')

export interface PricingPlanView {
  planId: string
  name: string
  tier: PricingTier
  currency: string
  unitAmount: number // centavos
  stripePriceId: string
}

/** Preços de todos os planos pagos para a faixa do país (default país→A). */
export async function resolvePricing(
  prisma: Pick<PrismaClient, 'planPrice'>,
  country?: string | null
): Promise<{ tier: PricingTier; plans: PricingPlanView[] }> {
  const tier = tierForCountry(country)
  const rows = await prisma.planPrice.findMany({
    where: { tier },
    include: { plan: true },
  })
  const plans = rows.map(
    (r: {
      planId: string
      plan: { name: string }
      tier: string
      currency: string
      unitAmount: number
      stripePriceId: string
    }) => ({
      planId: r.planId,
      name: r.plan.name,
      tier: r.tier as PricingTier,
      currency: r.currency,
      unitAmount: r.unitAmount,
      stripePriceId: r.stripePriceId,
    })
  )
  return { tier, plans }
}

/** A instância já bateu o teto de assinantes ativos? */
export async function atCapacity(prisma: Pick<PrismaClient, 'subscription'>): Promise<boolean> {
  const active = await prisma.subscription.count({ where: { status: 'active' } })
  return active >= ACTIVE_SUBSCRIPTION_CAP
}

export interface CheckoutInput {
  userId: string
  stripeCustomerId: string | null
  planId: string
  country?: string | null
  successUrl: string
  cancelUrl: string
}

/**
 * Cria a Checkout Session para (usuário, plano, faixa-do-país). Força coleta do
 * endereço de cobrança (o país do cartão é validado depois, no webhook). O
 * userId vai em client_reference_id pra amarrar a assinatura ao usuário.
 */
export async function createCheckoutSession(
  prisma: Pick<PrismaClient, 'planPrice'>,
  input: CheckoutInput
): Promise<{ url: string | null; tier: PricingTier }> {
  const tier = tierForCountry(input.country)
  const price = await prisma.planPrice.findUnique({
    where: { planId_tier: { planId: input.planId, tier } },
  })
  if (!price) throw new Error(`Sem preço para plano=${input.planId} faixa=${tier}`)

  const session = await getStripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: price.stripePriceId, quantity: 1 }],
    billing_address_collection: 'required',
    client_reference_id: input.userId,
    ...(input.stripeCustomerId ? { customer: input.stripeCustomerId } : {}),
    metadata: { userId: input.userId, planId: input.planId, tier },
    subscription_data: { metadata: { userId: input.userId, planId: input.planId, tier } },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  })
  return { url: session.url, tier }
}

/** Verifica a assinatura do webhook e devolve o evento (lança se inválido). */
export function constructWebhookEvent(rawBody: Buffer | string, signature: string): Stripe.Event {
  const secret = process.env['STRIPE_WEBHOOK_SECRET']
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET ausente no ambiente')
  return getStripe().webhooks.constructEvent(rawBody, signature, secret)
}

/**
 * Decisão pura do webhook de checkout: a compra é legítima? Aplica a coerência
 * país-do-cartão × faixa cobrada (anti-abuso: rico não paga preço de pobre).
 * Retorna a ação a executar — testável sem tocar no Stripe nem no banco.
 */
export function decideCheckout(params: {
  cardCountry: string | null | undefined
  chargedTier: PricingTier
}): { ok: boolean; reason?: string } {
  if (!cardTierIsCoherent(params.cardCountry, params.chargedTier)) {
    return {
      ok: false,
      reason: `país do cartão (${params.cardCountry ?? 'desconhecido'}) não é elegível à faixa ${params.chargedTier}`,
    }
  }
  return { ok: true }
}

/**
 * Sincroniza o estado local a partir de um evento de assinatura já validado.
 * Atualiza/gria a Subscription e deriva o User.planId. Idempotente.
 */
export async function syncSubscription(
  prisma: Pick<PrismaClient, 'subscription' | 'user'>,
  data: {
    userId: string
    stripeSubscriptionId: string
    planId: string
    tier: string
    status: string
    currentPeriodEnd?: Date | null
  }
): Promise<void> {
  await prisma.subscription.upsert({
    where: { userId: data.userId },
    update: {
      stripeSubscriptionId: data.stripeSubscriptionId,
      planId: data.planId,
      tier: data.tier,
      status: data.status,
      currentPeriodEnd: data.currentPeriodEnd ?? null,
    },
    create: {
      userId: data.userId,
      stripeSubscriptionId: data.stripeSubscriptionId,
      planId: data.planId,
      tier: data.tier,
      status: data.status,
      currentPeriodEnd: data.currentPeriodEnd ?? null,
    },
  })
  // Assinatura ativa → plano do usuário vira o plano pago; cancelada → volta free.
  const effectivePlan = data.status === 'active' ? data.planId : 'free'
  await prisma.user.update({ where: { id: data.userId }, data: { planId: effectivePlan } })
}
