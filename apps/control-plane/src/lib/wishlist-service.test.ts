import { describe, expect, it, vi } from 'vitest'
import { addItemToWishlist } from './wishlist-service.js'

describe('WishlistService', () => {
  it('adds item to wishlist', async () => {
    const deps = {
      prisma: {
        wishlistItem: {
          create: vi.fn().mockResolvedValue({
            id: 'item1',
            userId: 'user1',
            payload: 'My Item',
            source: 'telegram',
            createdAt: new Date(),
          }),
        },
      } as any,
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
  })
})
