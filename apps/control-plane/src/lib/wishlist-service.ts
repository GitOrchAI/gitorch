import { PrismaClient } from '@prisma/client'

export interface WishlistServiceDeps {
  prisma: PrismaClient
  broadcastEvent?: (wingId: string, event: string, data: unknown) => void
}

export async function addItemToWishlist(
  userId: string,
  payload: string,
  source: 'telegram',
  deps: WishlistServiceDeps
) {
  const item = await deps.prisma.wishlistItem.create({
    data: {
      userId,
      payload,
      source,
    },
  })

  if (deps.broadcastEvent) {
    deps.broadcastEvent(`user:${userId}`, 'wishlist:item_added', item)
  }

  return item
}
