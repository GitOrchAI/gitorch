import { PrismaClient } from '@prisma/client'

export interface WishlistServiceDeps {
  prisma: PrismaClient
}

export async function addItemToWishlist(
  userId: string,
  payload: string,
  source: 'telegram',
  deps: WishlistServiceDeps
) {
  return deps.prisma.wishlistItem.create({
    data: {
      userId,
      payload,
      source,
    },
  })
}
