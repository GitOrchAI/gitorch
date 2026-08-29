import { describe, it, expect, vi } from 'vitest'
import { resolveOwnerId } from './resolve-owner-id.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
function fakePrisma(userByEmail: Record<string, { id: string } | null>): any {
  return {
    user: {
      findUnique: vi.fn(
        async ({ where }: { where: { email: string } }) => userByEmail[where.email] ?? null
      ),
    },
  }
}

describe('resolveOwnerId', () => {
  it('sem e-mail devolve o id da sessão (legado single-tenant)', async () => {
    const prisma = fakePrisma({})
    expect(await resolveOwnerId(prisma, { id: 'sess_1' })).toBe('sess_1')
    expect(prisma.user.findUnique).not.toHaveBeenCalled()
  })

  it('e-mail que casa um User devolve o id DESSE User', async () => {
    const prisma = fakePrisma({ 'g@x.com': { id: 'owner_42' } })
    expect(await resolveOwnerId(prisma, { id: 'sess_1', email: 'g@x.com' })).toBe('owner_42')
  })

  it('e-mail sem User correspondente cai no id da sessão', async () => {
    const prisma = fakePrisma({ 'g@x.com': null })
    expect(await resolveOwnerId(prisma, { id: 'sess_1', email: 'g@x.com' })).toBe('sess_1')
  })
})
