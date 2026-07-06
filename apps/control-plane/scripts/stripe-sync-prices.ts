// Cria os Produtos e Preços do Stripe (um Price por plano×faixa, em USD no
// lançamento) e faz upsert em PlanPrice. Idempotente por (planId, tier):
// reusa o Product por plano e cria Price novo só se o valor mudou (Price é
// imutável no Stripe). Roda em modo TESTE com a STRIPE_SECRET_KEY do .env.
//
// Uso (após aplicar a migração e o seed dos planos):
//   cd apps/control-plane && npx tsx scripts/stripe-sync-prices.ts
//
// Ver docs/business/pricing-strategy.md para os valores e a lógica das faixas.

import Stripe from 'stripe'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// Valores em centavos. A = rica (USD), B = Brasil (BRL, R$19,90/59,90/199),
// C = land-grab (USD). Cada faixa cobra na moeda que faz sentido pro mercado.
const MATRIX: Record<string, { A: number; B: number; C: number }> = {
  solo: { A: 1000, B: 1990, C: 300 },
  pro: { A: 2900, B: 5990, C: 900 },
  team: { A: 7900, B: 19900, C: 2900 },
}
const CURRENCY_BY_TIER: Record<'A' | 'B' | 'C', string> = { A: 'usd', B: 'brl', C: 'usd' }

async function main(): Promise<void> {
  const key = process.env['STRIPE_SECRET_KEY']
  if (!key) throw new Error('STRIPE_SECRET_KEY ausente')
  if (!key.startsWith('sk_test_')) {
    // Trava de segurança: este script não roda em produção sem edição consciente.
    throw new Error('Recusado: use uma chave sk_test_ (modo teste) para o sync inicial')
  }
  const stripe = new Stripe(key)

  for (const [planId, byTier] of Object.entries(MATRIX)) {
    const plan = await prisma.plan.findUnique({ where: { id: planId } })
    if (!plan) {
      console.warn(`[stripe-sync] plano ${planId} não existe no banco; rode o seed antes. Pulando.`)
      continue
    }

    // Um Product por plano (reusa por metadata gitorch_plan).
    const existing = await stripe.products.search({ query: `metadata['gitorch_plan']:'${planId}'` })
    const product =
      existing.data[0] ??
      (await stripe.products.create({
        name: `GitOrch ${plan.name}`,
        metadata: { gitorch_plan: planId },
      }))

    for (const tier of ['A', 'B', 'C'] as const) {
      const amount = byTier[tier]
      const cur = CURRENCY_BY_TIER[tier]
      const current = await prisma.planPrice.findUnique({
        where: { planId_tier: { planId, tier } },
      })
      if (current && current.unitAmount === amount && current.currency === cur) {
        console.log(`[stripe-sync] ${planId}/${tier} inalterado (${amount} ${cur})`)
        continue
      }
      const price = await stripe.prices.create({
        product: product.id,
        currency: cur,
        unit_amount: amount,
        recurring: { interval: 'month' },
        metadata: { gitorch_plan: planId, gitorch_tier: tier },
      })
      await prisma.planPrice.upsert({
        where: { planId_tier: { planId, tier } },
        update: { currency: cur, unitAmount: amount, stripePriceId: price.id },
        create: { planId, tier, currency: cur, unitAmount: amount, stripePriceId: price.id },
      })
      console.log(`[stripe-sync] ${planId}/${tier} → ${price.id} (${amount} ${cur})`)
    }
  }
  console.log('[stripe-sync] concluído')
}

main()
  .catch((err) => {
    console.error('[stripe-sync] falhou:', err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
