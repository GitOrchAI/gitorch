import { FastifyPluginAsync } from 'fastify'
import { PrismaClient, Prisma } from '@prisma/client'
import { loadEnv } from '../config/env.js'
import { AsyncLocalStorage } from 'async_hooks'

const env = loadEnv()

export const wingIdContext = new AsyncLocalStorage<{ wingId: string }>()

// Isolamento por DONO. `wingId` no Project é o repositório ("owner/repo") — é
// o que o scheduler usa como endereço de clone e o que o webhook casa por
// full_name —, portanto NÃO serve como chave de tenant. O dono real é `userId`.
export const tenantContext = new AsyncLocalStorage<{ userId: string }>()

function getCurrentWingId(): string | undefined {
  return wingIdContext.getStore()?.wingId
}

function getCurrentUserId(): string | undefined {
  return tenantContext.getStore()?.userId
}

// Isolamento por tenant: a lista de modelos que carregam wingId vem do PRÓPRIO
// schema (DMMF), nunca de lista manual — uma lista hardcoded desalinhou do
// schema e derrubava qualquer escrita em modelos sem a coluna (ex.:
// WebhookDelivery) dentro de um wingIdContext.
export const MODELS_WITH_WING: ReadonlySet<string> = new Set(
  (Prisma.dmmf.datamodel.models as Array<{ name: string; fields: Array<{ name: string }> }>)
    .filter((m) => m.fields.some((f) => f.name === 'wingId'))
    .map((m) => m.name)
)

export const MODELS_WITH_USER: ReadonlySet<string> = new Set(
  (Prisma.dmmf.datamodel.models as Array<{ name: string; fields: Array<{ name: string }> }>)
    .filter((m) => m.fields.some((f) => f.name === 'userId'))
    .map((m) => m.name)
)

const SCOPED_ACTIONS = [
  'findMany',
  'findUnique',
  'findFirst',
  'create',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
] as const

/**
 * Injeta o escopo do tenant nas queries da request corrente.
 *
 * Extraído do middleware para ser testável de verdade: a versão anterior vivia
 * dentro do `$use` e nunca era exercida, o que escondeu por completo o fato de
 * que o contexto sequer estava ativo (era aberto com um callback vazio).
 */
export function applyTenantScope(params: Prisma.MiddlewareParams): void {
  if (!SCOPED_ACTIONS.includes(params.action as (typeof SCOPED_ACTIONS)[number])) return

  const model = params.model ?? ''
  const userId = getCurrentUserId()

  if (userId && MODELS_WITH_USER.has(model)) {
    if (params.action === 'create') {
      params.args.data = { ...params.args.data, userId }
    } else {
      params.args.where = { ...params.args.where, userId }
    }
    return
  }

  // Escopo por projeto (usado pelo webhook do GitHub, que opera fora de uma
  // sessão de usuário e precisa se limitar ao projeto do evento).
  const wingId = getCurrentWingId()
  if (wingId && MODELS_WITH_WING.has(model)) {
    if (params.action === 'create') {
      params.args.data = { ...params.args.data, wingId }
    } else {
      params.args.where = { ...params.args.where, wingId }
    }
  }
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
      applyTenantScope(params)
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
