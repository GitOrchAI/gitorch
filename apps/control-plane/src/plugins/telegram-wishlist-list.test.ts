import { describe, it, expect, vi } from 'vitest'
import { processarComandoWishlistList } from './telegram.js'

describe('processarComandoWishlistList', () => {
  it('should return empty message when no items', async () => {
    const sendMsg = vi.fn()
    const app = {
      prisma: {
        wishlistItem: {
          findMany: vi.fn().mockResolvedValue([]),
        },
      } as unknown as Parameters<typeof processarComandoWishlistList>[1]['prisma'],
      log: { error: vi.fn() },
    }

    await processarComandoWishlistList({ userId: 'u1' }, app, sendMsg)

    expect(app.prisma.wishlistItem.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'asc' },
    })
    expect(sendMsg).toHaveBeenCalledWith('Your wishlist is empty.')
  })

  it('should return formatted list of items', async () => {
    const sendMsg = vi.fn()
    const app = {
      prisma: {
        wishlistItem: {
          findMany: vi.fn().mockResolvedValue([{ payload: 'Item A' }, { payload: 'Item B' }]),
        },
      } as unknown as Parameters<typeof processarComandoWishlistList>[1]['prisma'],
      log: { error: vi.fn() },
    }

    await processarComandoWishlistList({ userId: 'u1' }, app, sendMsg)

    expect(app.prisma.wishlistItem.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'asc' },
    })
    expect(sendMsg).toHaveBeenCalledWith('1. Item A\n2. Item B')
  })

  it('should handle errors gracefully', async () => {
    const sendMsg = vi.fn()
    const logError = vi.fn()
    const app = {
      prisma: {
        wishlistItem: {
          findMany: vi.fn().mockRejectedValue(new Error('db error')),
        },
      } as unknown as Parameters<typeof processarComandoWishlistList>[1]['prisma'],
      log: { error: logError },
    }

    await processarComandoWishlistList({ userId: 'u1' }, app, sendMsg)

    expect(logError).toHaveBeenCalled()
    expect(sendMsg).toHaveBeenCalledWith('Erro interno ao listar a wishlist.')
  })
})
