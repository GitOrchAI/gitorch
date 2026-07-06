import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type Stripe from 'stripe'
import {
  resolvePricing,
  atCapacity,
  createCheckoutSession,
  constructWebhookEvent,
  decideCheckout,
  syncSubscription,
} from '../services/billing.js'
import type { PricingTier } from '../lib/geo-pricing.js'

// País do visitante: header de geo do CDN (Cloudflare) ou override por query.
// Sem geo confiável → undefined, e a faixa cai em A (paga cheio) por segurança.
function countryFrom(request: FastifyRequest): string | undefined {
  const q = (request.query as Record<string, string> | undefined)?.['country']
  const cf = request.headers['cf-ipcountry']
  const cc = q ?? (typeof cf === 'string' ? cf : undefined)
  return cc && cc !== 'XX' ? cc : undefined
}

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/pricing — preços da faixa do país (para a landing exibir).
  app.get('/api/pricing', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const out = await resolvePricing(app.prisma, countryFrom(request))
      return reply.header('cache-control', 'public, max-age=300').send(out)
    } catch (err) {
      app.log.error({ err }, '[billing] /api/pricing falhou')
      return reply.code(500).send({ error: 'pricing_unavailable' })
    }
  })

  // POST /api/waitlist — cap de capacidade: novos interessados entram aqui.
  app.post('/api/waitlist', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const email = typeof body['email'] === 'string' ? body['email'].trim().toLowerCase() : ''
    if (!email || !email.includes('@')) {
      return reply.code(400).send({ error: 'email_invalido' })
    }
    const entry = await app.prisma.waitlist.upsert({
      where: { email },
      update: {},
      create: {
        email,
        githubLogin: typeof body['githubLogin'] === 'string' ? body['githubLogin'] : null,
        requestedPlanId: typeof body['planId'] === 'string' ? body['planId'] : null,
        country: countryFrom(request) ?? null,
      },
    })
    return reply.code(201).send({ status: entry.status })
  })

  // POST /api/billing/checkout — se a infra estiver no teto, manda pra waitlist;
  // senão cria a Checkout Session e devolve a URL do Stripe.
  app.post('/api/billing/checkout', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const userId = typeof body['userId'] === 'string' ? body['userId'] : ''
    const planId = typeof body['planId'] === 'string' ? body['planId'] : ''
    if (!userId || !planId) return reply.code(400).send({ error: 'userId_e_planId_obrigatorios' })

    if (await atCapacity(app.prisma)) {
      return reply.code(402).send({ error: 'at_capacity', action: 'waitlist' })
    }

    const user = await app.prisma.user.findUnique({ where: { id: userId } })
    if (!user) return reply.code(404).send({ error: 'user_nao_encontrado' })

    const base = process.env['GITORCH_PUBLIC_WEB_URL'] ?? ''
    try {
      const { url, tier } = await createCheckoutSession(app.prisma, {
        userId,
        stripeCustomerId: user.stripeCustomerId,
        planId,
        country: countryFrom(request) ?? null,
        successUrl: `${base}/painel?checkout=ok`,
        cancelUrl: `${base}/#planos`,
      })
      return reply.send({ url, tier })
    } catch (err) {
      app.log.error({ err }, '[billing] checkout falhou')
      return reply.code(500).send({ error: 'checkout_failed' })
    }
  })

  // POST /api/billing/webhook — escopo isolado com parser de BUFFER, porque a
  // verificação de assinatura do Stripe precisa dos bytes crus (JSON.stringify
  // não serve). O parser só vale dentro deste register.
  await app.register(async (scoped) => {
    scoped.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body)
    )

    scoped.post('/api/billing/webhook', async (request: FastifyRequest, reply: FastifyReply) => {
      const sig = request.headers['stripe-signature']
      if (typeof sig !== 'string') return reply.code(400).send({ error: 'missing_signature' })

      let event: Stripe.Event
      try {
        event = constructWebhookEvent(request.body as Buffer, sig)
      } catch (err) {
        app.log.warn({ err }, '[billing] assinatura de webhook inválida')
        return reply.code(400).send({ error: 'invalid_signature' })
      }

      try {
        if (event.type === 'checkout.session.completed') {
          const session = event.data.object as Stripe.Checkout.Session
          const meta = session.metadata ?? {}
          const chargedTier = (meta['tier'] as PricingTier) ?? 'A'
          const cardCountry = session.customer_details?.address?.country ?? null
          const decision = decideCheckout({ cardCountry, chargedTier })
          if (!decision.ok) {
            // Incoerência país-cartão × faixa: cancela a assinatura recém-criada.
            app.log.warn({ reason: decision.reason }, '[billing] checkout incoerente; cancelando')
            if (typeof session.subscription === 'string') {
              await import('../services/billing.js').then(({ getStripe }) =>
                getStripe().subscriptions.cancel(session.subscription as string)
              )
            }
            return reply.send({ received: true, action: 'canceled_incoherent' })
          }
        }

        if (
          event.type === 'customer.subscription.created' ||
          event.type === 'customer.subscription.updated' ||
          event.type === 'customer.subscription.deleted'
        ) {
          const sub = event.data.object as Stripe.Subscription
          const meta = sub.metadata ?? {}
          const userId = meta['userId']
          if (userId) {
            await syncSubscription(app.prisma, {
              userId,
              stripeSubscriptionId: sub.id,
              planId: meta['planId'] ?? 'free',
              tier: meta['tier'] ?? 'A',
              status: sub.status,
              currentPeriodEnd: sub.items?.data?.[0]?.current_period_end
                ? new Date(sub.items.data[0].current_period_end * 1000)
                : null,
            })
          }
        }

        return reply.send({ received: true })
      } catch (err) {
        app.log.error({ err }, '[billing] processamento do webhook falhou')
        return reply.code(500).send({ error: 'webhook_processing_failed' })
      }
    })
  })
}
