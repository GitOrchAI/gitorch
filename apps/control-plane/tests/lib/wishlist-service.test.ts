import { describe, expect, it, vi } from 'vitest'
import { addItemToWishlist } from '../../src/lib/wishlist-service.js'
import { PrismaClient } from '@prisma/client'

describe('Wishlist Service', () => {
  it('adds an item correctly', async () => {
    const mockPrisma = {
      wishlistItem: {
        create: vi.fn().mockResolvedValue({
          id: 'test-id',
          userId: 'user1',
          payload: 'my item',
          source: 'telegram',
          createdAt: new Date(),
        })
      }
    } as unknown as PrismaClient

    const result = await addItemToWishlist('user1', 'my item', 'telegram', { prisma: mockPrisma })

    expect(mockPrisma.wishlistItem.create).toHaveBeenCalledWith({
      data: {
        userId: 'user1',
        payload: 'my item',
        source: 'telegram',
      }
    })
    expect(result.id).toBe('test-id')
  })
})
