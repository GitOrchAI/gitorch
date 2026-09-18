import { describe, it, expect, vi, beforeEach } from 'vitest'
import { addWishlistItem } from './wishlist-service.js'
import { FastifyInstance } from 'fastify'

describe('wishlist-service', () => {
  it('should persist the item and call broadcastEvent when available', async () => {
    const mockCreatedItem = { id: 'item-1', userId: 'user-1', payload: 'test', source: 'telegram' }
    const createMock = vi.fn().mockResolvedValue(mockCreatedItem)
    const broadcastEventMock = vi.fn()

    const app = {
      prisma: {
        wishlistItem: {
          create: createMock,
        },
      },
      broadcastEvent: broadcastEventMock,
    } as unknown as FastifyInstance

    const result = await addWishlistItem(app, 'user-1', { payload: 'test' }, 'telegram')

    expect(createMock).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        payload: 'test',
        source: 'telegram',
      },
    })
    expect(broadcastEventMock).toHaveBeenCalledWith('user-1', 'wishlist_updated', {
      item: mockCreatedItem,
    })
    expect(result).toBe(mockCreatedItem)
  })
})
