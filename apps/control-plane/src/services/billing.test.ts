import { describe, expect, it, vi } from 'vitest'
import {
  resolvePricing,
  atCapacity,
  decideCheckout,
  syncSubscription,
  ACTIVE_SUBSCRIPTION_CAP,
} from './billing.js'

describe('resolvePricing', () => {
  it('busca preços da faixa do país e projeta a view', async () => {
    const prisma = {
      planPrice: {
        findMany: vi.fn().mockResolvedValue([
          {
            planId: 'solo',
            tier: 'B',
            currency: 'usd',
            unitAmount: 360,
            stripePriceId: 'price_1',
            plan: { name: 'Solo' },
          },
        ]),
      },
    } as never
    const out = await resolvePricing(prisma, 'BR')
    expect(out.tier).toBe('B')
    expect(prisma).toBeDefined()
    expect(out.plans[0]).toMatchObject({
      planId: 'solo',
      name: 'Solo',
      unitAmount: 360,
      stripePriceId: 'price_1',
    })
  })

  it('país desconhecido resolve faixa A', async () => {
    const findMany = vi.fn().mockResolvedValue([])
    await resolvePricing({ planPrice: { findMany } } as never, undefined)
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tier: 'A' } }))
  })
})

describe('atCapacity', () => {
  it('true quando assinaturas ativas atingem o teto', async () => {
    const prisma = {
      subscription: { count: vi.fn().mockResolvedValue(ACTIVE_SUBSCRIPTION_CAP) },
    } as never
    expect(await atCapacity(prisma)).toBe(true)
  })
  it('false abaixo do teto', async () => {
    const prisma = { subscription: { count: vi.fn().mockResolvedValue(0) } } as never
    expect(await atCapacity(prisma)).toBe(false)
  })
})

describe('decideCheckout (anti-abuso país-cartão × faixa)', () => {
  it('aprova cartão coerente', () => {
    expect(decideCheckout({ cardCountry: 'BR', chargedTier: 'B' }).ok).toBe(true)
    expect(decideCheckout({ cardCountry: 'IN', chargedTier: 'A' }).ok).toBe(true)
  })
  it('recusa rico pagando faixa pobre', () => {
    const d = decideCheckout({ cardCountry: 'US', chargedTier: 'C' })
    expect(d.ok).toBe(false)
    expect(d.reason).toContain('US')
  })
  it('cartão desconhecido só passa na faixa A', () => {
    expect(decideCheckout({ cardCountry: null, chargedTier: 'A' }).ok).toBe(true)
    expect(decideCheckout({ cardCountry: null, chargedTier: 'B' }).ok).toBe(false)
  })
})

describe('syncSubscription', () => {
  it('assinatura ativa aplica o plano pago no usuário', async () => {
    const subUpsert = vi.fn().mockResolvedValue({})
    const userUpdate = vi.fn().mockResolvedValue({})
    const prisma = { subscription: { upsert: subUpsert }, user: { update: userUpdate } } as never
    await syncSubscription(prisma, {
      userId: 'u1',
      stripeSubscriptionId: 'sub_1',
      planId: 'pro',
      tier: 'A',
      status: 'active',
    })
    expect(userUpdate).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { planId: 'pro' } })
  })
  it('assinatura cancelada rebaixa o usuário para free', async () => {
    const userUpdate = vi.fn().mockResolvedValue({})
    const prisma = {
      subscription: { upsert: vi.fn().mockResolvedValue({}) },
      user: { update: userUpdate },
    } as never
    await syncSubscription(prisma, {
      userId: 'u1',
      stripeSubscriptionId: 'sub_1',
      planId: 'pro',
      tier: 'A',
      status: 'canceled',
    })
    expect(userUpdate).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { planId: 'free' } })
  })
})
