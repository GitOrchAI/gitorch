import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { setupRoutes } from './setup.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
function fakePrisma() {
  const store = new Map<string, any>()
  let seq = 0
  return {
    clientEnvironment: {
      findFirst: vi.fn(async ({ where }: any) => {
        const rows = [...store.values()].filter(
          (r) => r.userId === where.userId && r.status === where.status
        )
        return rows[rows.length - 1] ?? null
      }),
      create: vi.fn(async ({ data }: any) => {
        const now = new Date()
        const rec = { id: `env_${++seq}`, fixedAt: null, createdAt: now, updatedAt: now, ...data }
        store.set(rec.id, rec)
        return rec
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const rec = { ...store.get(where.id), ...data }
        store.set(where.id, rec)
        return rec
      }),
    },
  }
}

describe('POST /api/v1/setup/environment', () => {
  let app: ReturnType<typeof Fastify>
  let baseDir: string
  const orig = process.env['GITORCH_ENVIRONMENTS_DIR']

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-envroute-'))
    process.env['GITORCH_ENVIRONMENTS_DIR'] = baseDir
    app = Fastify()
    app.decorate('prisma', fakePrisma() as any)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'user_1', wingId: 'octocat' }
    })
    await setupRoutes(app)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    await fs.rm(baseDir, { recursive: true, force: true })
    if (orig === undefined) delete process.env['GITORCH_ENVIRONMENTS_DIR']
    else process.env['GITORCH_ENVIRONMENTS_DIR'] = orig
  })

  it('cria o ambiente provisório e responde só id/status (nunca o path interno)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/setup/environment' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('provisional')
    expect(body.id).toBeTruthy()
    // Regra de infra: o caminho em disco é interno, nunca exposto ao cliente.
    expect(body.path).toBeUndefined()
  })

  it('é idempotente: reabrir o wizard reusa o mesmo ambiente', async () => {
    const a = (await app.inject({ method: 'POST', url: '/api/v1/setup/environment' })).json()
    const b = (await app.inject({ method: 'POST', url: '/api/v1/setup/environment' })).json()
    expect(b.id).toBe(a.id)
  })
})

describe('POST /api/v1/setup/environment — sem sessão', () => {
  it('retorna 401 sem criar nada', async () => {
    const app = Fastify()
    app.decorate('prisma', fakePrisma() as any)
    await setupRoutes(app)
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/api/v1/setup/environment' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})
