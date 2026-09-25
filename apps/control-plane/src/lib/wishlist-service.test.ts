import { describe, expect, it, vi } from 'vitest'
import { addItemToWishlist } from './wishlist-service.js'

describe('WishlistService', () => {
  it('adds item to wishlist and broadcasts SSE', async () => {
    const mockItem = {
      id: 'item1',
      userId: 'user1',
      payload: 'My Item',
      source: 'telegram',
      targetRepositoryIds: [],
      isCrossRepo: false,
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
        targetRepositoryIds: [],
        isCrossRepo: false,
      },
    })
    expect(broadcastEvent).toHaveBeenCalledWith('user:user1', 'wishlist:item_added', mockItem)
  })

  it('adds item with single repo scope', async () => {
    const mockItem = {
      id: 'item2',
      userId: 'user2',
      payload: 'Single repo item',
      source: 'telegram',
      targetRepositoryIds: ['repo1'],
      isCrossRepo: false,
      createdAt: new Date(),
    }

    const deps = {
      prisma: {
        wishlistItem: {
          create: vi.fn().mockResolvedValue(mockItem),
        },
      } as unknown as import('@prisma/client').PrismaClient,
    }

    const item = await addItemToWishlist('user2', 'Single repo item', 'telegram', deps, {
      targetRepositoryIds: ['repo1'],
    })

    expect(item.id).toBe('item2')
    expect(item.targetRepositoryIds).toEqual(['repo1'])
    expect(item.isCrossRepo).toBe(false)
    expect(deps.prisma.wishlistItem.create).toHaveBeenCalledWith({
      data: {
        userId: 'user2',
        payload: 'Single repo item',
        source: 'telegram',
        targetRepositoryIds: ['repo1'],
        isCrossRepo: false,
      },
    })
  })

  it('resolves multi-repo config when cross-repo intention is indicated', async () => {
    const mockItem = {
      id: 'item3',
      userId: 'user3',
      payload: 'Cross repo item',
      source: 'telegram',
      targetRepositoryIds: ['backend-repo', 'frontend-repo'],
      isCrossRepo: true,
      createdAt: new Date(),
    }

    const deps = {
      prisma: {
        wishlistItem: {
          create: vi.fn().mockResolvedValue(mockItem),
        },
      } as unknown as import('@prisma/client').PrismaClient,
    }

    const projectConfig = {
      repositories: [
        {
          id: 'backend-repo',
          url: 'repo-url-1',
          name: 'Backend',
          defaultBranch: 'main',
          role: 'backend',
        },
        ,
        {
          id: 'frontend-repo',
          url: 'repo-url-2',
          name: 'Frontend',
          defaultBranch: 'main',
          role: 'frontend',
        },
      ],
    }

    // cast to any to bypass exact interface match requirement in tests
    const item = await addItemToWishlist('user3', 'Cross repo item', 'telegram', deps, {
      isCrossRepo: true,
      projectConfig: projectConfig as unknown as import('./project-defaults.js').ProjectConfig,
    })

    expect(item.id).toBe('item3')
    expect(item.targetRepositoryIds).toEqual(['backend-repo', 'frontend-repo'])
    expect(item.isCrossRepo).toBe(true)
    expect(deps.prisma.wishlistItem.create).toHaveBeenCalledWith({
      data: {
        userId: 'user3',
        payload: 'Cross repo item',
        source: 'telegram',
        targetRepositoryIds: ['backend-repo', 'frontend-repo'],
        isCrossRepo: true,
      },
    })
  })

  it('retrieves wishlist items with resolved roles', async () => {
    const mockItem = {
      id: 'item4',
      userId: 'user4',
      payload: 'Cross repo item',
      source: 'telegram',
      targetRepositoryIds: ['backend-repo', 'frontend-repo', 'missing-repo'],
      isCrossRepo: true,
      createdAt: new Date(),
    }

    const deps = {
      prisma: {
        wishlistItem: {
          findMany: vi.fn().mockResolvedValue([mockItem]),
        },
      } as unknown as import('@prisma/client').PrismaClient,
      projectConfig: {
        repositories: [
          {
            id: 'backend-repo',
            url: 'repo-url-1',
            name: 'Backend',
            defaultBranch: 'main',
            role: 'backend',
          },
          ,
          {
            id: 'frontend-repo',
            url: 'repo-url-2',
            name: 'Frontend',
            defaultBranch: 'main',
            role: 'frontend',
          },
        ],
      } as unknown as import('./project-defaults.js').ProjectConfig,
    }

    // cast to any to bypass exact interface match requirement in tests
    const items = await import('./wishlist-service.js').then((m) =>
      m.getUserWishlist('user4', deps)
    )

    expect(items.length).toBe(1)
    expect(items[0]?.id).toBe('item4')
    expect(items[0]?.resolvedRepositories).toEqual([
      { id: 'backend-repo', role: 'backend' },
      { id: 'frontend-repo', role: 'frontend' },
      { id: 'missing-repo', role: 'unknown' },
    ])
    expect(deps.prisma.wishlistItem.findMany).toHaveBeenCalledWith({
      where: { userId: 'user4' },
      orderBy: { createdAt: 'desc' },
    })
  })
})
