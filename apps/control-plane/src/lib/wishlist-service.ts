import { PrismaClient, WishlistItem } from '@prisma/client'
import { ProjectConfig, getDefaultProjectConfig } from './project-defaults.js'

export interface WishlistServiceDeps {
  prisma: PrismaClient
  broadcastEvent?: (wingId: string, event: string, data: unknown) => void
}

export interface WishlistRetrievalDeps {
  prisma: PrismaClient
  projectConfig?: ProjectConfig | string | null
}

export interface WishlistItemWithRoles extends WishlistItem {
  resolvedRepositories?: { id: string, role: string }[]
}

export async function addItemToWishlist(
  userId: string,
  payload: string,
  source: 'telegram',
  deps: WishlistServiceDeps,
  options?: {
    targetRepositoryIds?: string[]
    isCrossRepo?: boolean
    projectConfig?: ProjectConfig | string | null
  }
) {
  let targetRepoIds = options?.targetRepositoryIds ?? []
  let isCrossRepo = options?.isCrossRepo ?? false

  // Se indicar intenção full-stack/cross-repo, resolve a partir de projectConfig se fornecido
  if (isCrossRepo && options?.projectConfig) {
    const config = getDefaultProjectConfig(options.projectConfig)
    if (config.repositories.length > 0) {
      targetRepoIds = config.repositories.map(repo => repo.id)
    }
  }

  const item = await deps.prisma.wishlistItem.create({
    data: {
      userId,
      payload,
      source,
      targetRepositoryIds: targetRepoIds,
      isCrossRepo: isCrossRepo,
    },
  })

  if (deps.broadcastEvent) {
    deps.broadcastEvent(`user:${userId}`, 'wishlist:item_added', item)
  }

  return item
}

export async function getUserWishlist(
  userId: string,
  deps: WishlistRetrievalDeps
): Promise<WishlistItemWithRoles[]> {
  const items = await deps.prisma.wishlistItem.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  })

  if (!deps.projectConfig) {
     return items
  }

  const config = getDefaultProjectConfig(deps.projectConfig)

  return items.map((item) => {
    if (!item.targetRepositoryIds || item.targetRepositoryIds.length === 0) {
       return item
    }

    const resolvedRepositories = item.targetRepositoryIds.map((id) => {
      const repo = config.repositories.find((r) => r.id === id)
      return { id, role: repo ? repo.role : 'unknown' }
    })

    return { ...item, resolvedRepositories }
  })
}
