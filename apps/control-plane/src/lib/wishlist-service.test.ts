import { describe, expect, it, vi } from 'vitest'
import { addItemToWishlist } from './wishlist-service.js'

describe('WishlistService', () => {
  it('adds item to wishlist and broadcasts SSE', async () => {
    const mockItem = {
      id: 'item1',
      userId: 'user1',
      payload: 'My Item',
      source: 'telegram',
      createdAt: new Date(),
    }

    const broadcastEvent = vi.fn()
    const deps = {
      prisma: {
        wishlistItem: {
          create: vi.fn().mockResolvedValue(mockItem),
        },
      } as unknown as import('@prisma/client').PrismaClient,
      broadcastEvent,
    }

    const item = await addItemToWishlist('user1', 'My Item', 'telegram', deps)

    expect(item.id).toBe('item1')
    expect(deps.prisma.wishlistItem.create).toHaveBeenCalledWith({
      data: {
        userId: 'user1',
        payload: 'My Item',
        source: 'telegram',
      },
    })
    expect(broadcastEvent).toHaveBeenCalledWith('user:user1', 'wishlist:item_added', mockItem)
  })
})
