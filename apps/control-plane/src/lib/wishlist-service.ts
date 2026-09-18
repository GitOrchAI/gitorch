import { FastifyInstance } from 'fastify'
import '../plugins/sse.js'

interface AddItemPayload {
  payload: string
}

export async function addWishlistItem(
  app: FastifyInstance,
  userId: string,
  data: AddItemPayload,
  source: 'telegram'
) {
  const item = await app.prisma.wishlistItem.create({
    data: {
      userId,
      payload: data.payload,
      source,
    },
  })

  // Broadcast via SSE if the plugin is available
  if ('broadcastEvent' in app && typeof app.broadcastEvent === 'function') {
    app.broadcastEvent(userId, 'wishlist_updated', {
      item,
    })
  }

  return item
}
