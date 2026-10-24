import { describe, it, expect, vi } from 'vitest'
import {
  processarComandoWishlistList,
  WISHLIST_VAZIA,
  BOTAO_REMOVER_DA_WISHLIST,
} from './telegram.js'

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
    expect(sendMsg).toHaveBeenCalledWith('Sua wishlist está vazia.')
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
    expect(sendMsg).toHaveBeenCalledWith('1. Item A\n2. Item B', {
      inline_keyboard: [
        [{ text: '❌ Remover', callback_data: 'del_wishlist_undefined' }],
        [{ text: '❌ Remover', callback_data: 'del_wishlist_undefined' }],
      ],
    })
  })

  it('não fala inglês com o dono, nem na lista vazia nem no botão de remover', async () => {
    const enviados: unknown[][] = []
    const sendMsg = vi.fn(async (...args: unknown[]) => {
      enviados.push(args)
    })
    const vazia = {
      prisma: {
        wishlistItem: { findMany: vi.fn().mockResolvedValue([]) },
      } as unknown as Parameters<typeof processarComandoWishlistList>[1]['prisma'],
      log: { error: vi.fn() },
    }
    const cheia = {
      prisma: {
        wishlistItem: { findMany: vi.fn().mockResolvedValue([{ id: 'w1', payload: 'Item A' }]) },
      } as unknown as Parameters<typeof processarComandoWishlistList>[1]['prisma'],
      log: { error: vi.fn() },
    }

    await processarComandoWishlistList({ userId: 'u1' }, vazia, sendMsg)
    await processarComandoWishlistList({ userId: 'u1' }, cheia, sendMsg)

    const tudo = JSON.stringify(enviados)
    expect(tudo).not.toMatch(/wishlist is empty|Delete/i)
    expect(WISHLIST_VAZIA).not.toMatch(/empty/i)
    expect(BOTAO_REMOVER_DA_WISHLIST).not.toMatch(/delete/i)
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
