import { prisma } from './plugins/prisma.js'
import { SynapseClient } from '@gitorch/synapse'
import { resolveNotifyChatId } from './services/telegram-link.js'
import { sendTelegramMessage } from './services/telegram-bot.js'

export async function processWishlistQueue() {
  const synapse = new SynapseClient()
  const botToken = process.env['GITORCH_TELEGRAM_BOT_TOKEN'] ?? process.env['TELEGRAM_BOT_TOKEN']

  if (!botToken) {
    console.warn(
      '[wishlist-worker] TELEGRAM_BOT_TOKEN is not set. Wishlist processing will not send messages.'
    )
  }

  while (true) {
    const item = await prisma.wishlistItem.findFirst({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      include: { user: true },
    })

    if (!item) {
      break
    }

    await prisma.wishlistItem.update({
      where: { id: item.id },
      data: { status: 'processing' },
    })

    try {
      // Pass the raw payload to the Synapse client to extract metadata.
      const meta = await synapse.fetchProductMetadata(item.payload)
      const title = meta.title
      const price = meta.price

      const updatedItem = await prisma.wishlistItem.update({
        where: { id: item.id },
        data: {
          title,
          price,
          status: 'completed',
        },
      })

      // Send a follow-up Telegram message
      if (botToken) {
        const chatId = await resolveNotifyChatId(prisma, { userId: updatedItem.userId })
        if (chatId) {
          const priceDisplay = price != null ? `$${price.toFixed(2)}` : 'Unknown price'
          const messageText = `Item enriched successfully!\n\nTitle: ${title}\nPrice: ${priceDisplay}\nURL: ${item.payload}`
          await sendTelegramMessage({
            botToken,
            chatId,
            text: messageText,
          })
        }
      }
    } catch (err) {
      console.error('[wishlist-worker] Failed to process item', item.id, err)
      await prisma.wishlistItem.update({
        where: { id: item.id },
        data: { status: 'failed_enrichment' },
      })
    }
  }
}

export function startWishlistWorker() {
  setInterval(() => {
    processWishlistQueue().catch((err) => {
      console.error('[wishlist-worker] error in queue loop', err)
    })
  }, 5000)
}
