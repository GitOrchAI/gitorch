import { PrismaClient, Prisma } from '@prisma/client'
import { loadEnv } from '../config/env.js'
import { AsyncLocalStorage } from 'async_hooks'

const env = loadEnv()

declare global {
  var prisma: PrismaClient | undefined
}

export const wingIdContext = new AsyncLocalStorage<{ wingId: string }>()

function getCurrentWingId(): string | undefined {
  return wingIdContext.getStore()?.wingId
}

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log: env['NODE_ENV'] === 'development' ? ['query', 'error', 'warn'] : ['error'],
    errorFormat: 'pretty',
  })

  // Row-Level Security middleware: inject wing_id on all queries
  client.$use(
    async (
      params: Prisma.MiddlewareParams,
      next: (params: Prisma.MiddlewareParams) => Promise<unknown>
    ) => {
      const wingId = getCurrentWingId()

      if (
        wingId &&
        [
          'findMany',
          'findUnique',
          'findFirst',
          'create',
          'update',
          'updateMany',
          'delete',
          'deleteMany',
        ].includes(params.action)
      ) {
        const modelsWithWing = ['Project', 'Mission', 'Event', 'ApiKey', 'WebhookDelivery']

        if (modelsWithWing.includes(params.model ?? '')) {
          if (params.action === 'findUnique' || params.action === 'findFirst') {
            params.args.where = {
              ...params.args.where,
              wingId,
            }
          } else if (params.action === 'findMany') {
            params.args.where = {
              ...params.args.where,
              wingId,
            }
          } else if (params.action === 'create') {
            params.args.data = {
              ...params.args.data,
              wingId,
            }
          } else if (['update', 'updateMany', 'delete', 'deleteMany'].includes(params.action)) {
            params.args.where = {
              ...params.args.where,
              wingId,
            }
          }
        }
      }

      return next(params)
    }
  )

  return client
}

export const prisma = global.prisma ?? createPrismaClient()

if (process.env['NODE_ENV'] !== 'production') global.prisma = prisma

export async function disconnectPrisma() {
  await prisma.$disconnect()
}

export { createPrismaClient }
