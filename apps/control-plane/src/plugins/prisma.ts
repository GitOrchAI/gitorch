import { FastifyPluginAsync } from 'fastify'
import { PrismaClient, Prisma } from '@prisma/client'
import { loadEnv } from '../config/env.js'
import { AsyncLocalStorage } from 'async_hooks'

const env = loadEnv()

export const wingIdContext = new AsyncLocalStorage<{ wingId: string }>()

function getCurrentWingId(): string | undefined {
  return wingIdContext.getStore()?.wingId
}

export function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log: env['NODE_ENV'] === 'development' ? ['query', 'error', 'warn'] : ['error'],
    errorFormat: 'pretty',
  })

  client.$use(
    async (
      params: Prisma.MiddlewareParams,
      next: (params: Prisma.MiddlewareParams) => Promise<unknown>
    ) => {
      const wingId = getCurrentWingId()
      if (wingId && ['findMany', 'findUnique', 'findFirst', 'create', 'update', 'updateMany', 'delete', 'deleteMany'].includes(params.action)) {
        const modelsWithWing = ['Project', 'Mission', 'Event', 'ApiKey', 'WebhookDelivery']
        if (modelsWithWing.includes(params.model ?? '')) {
          if (params.action === 'findUnique' || params.action === 'findFirst') {
            params.args.where = { ...params.args.where, wingId }
          } else if (params.action === 'findMany') {
            params.args.where = { ...params.args.where, wingId }
          } else if (params.action === 'create') {
            params.args.data = { ...params.args.data, wingId }
          } else if (['update', 'updateMany', 'delete', 'deleteMany'].includes(params.action)) {
            params.args.where = { ...params.args.where, wingId }
          }
        }
      }
      return next(params)
    }
  )
  return client
}

export const prisma = createPrismaClient()

export const prismaPlugin: FastifyPluginAsync = async (app) => {
  if (!app.hasDecorator('prisma')) {
    app.decorate('prisma', prisma)
  }
  
  app.addHook('onClose', async (app) => {
    await app.prisma.$disconnect()
  })
}

Object.assign(prismaPlugin, { [Symbol.for('skip-override')]: true })
