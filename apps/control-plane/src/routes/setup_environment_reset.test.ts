import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { setupRoutes } from './setup.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
// Mesmo fake de client_environments dos outros testes de setup.ts, com
// `delete` a mais (destroy() precisa dele) — padrão de environment.test.ts.
function fakePrisma() {
  const store = new Map<string, any>()
  let seq = 0
  return {
    store,
    clientEnvironment: {
      findFirst: vi.fn(async ({ where, orderBy }: any) => {
        let rows = [...store.values()].filter(
          (r) =>
            r.userId === where.userId && (where.status === undefined || r.status === where.status)
        )
        if (orderBy?.createdAt === 'desc') {
          rows = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        }
        return rows[0] ?? null
      }),
      create: vi.fn(async ({ data }: any) => {
        const now = new Date()
        const rec = {
          id: `env_${++seq}`,
          fixedAt: null,
          createdAt: now,
          updatedAt: now,
          lastActivityAt: now,
          ...data,
        }
        store.set(rec.id, rec)
        return rec
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const rec = { ...store.get(where.id), ...data, updatedAt: new Date() }
        store.set(where.id, rec)
        return rec
      }),
      findUnique: vi.fn(async ({ where }: any) => store.get(where.id) ?? null),
      delete: vi.fn(async ({ where }: any) => {
        const rec = store.get(where.id)
        store.delete(where.id)
        return rec ?? null
      }),
    },
  }
}

describe('POST /api/v1/setup/environment/reset', () => {
  let app: ReturnType<typeof Fastify>
  let baseDir: string
  const orig = process.env['GITORCH_ENVIRONMENTS_DIR']

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-reset-'))
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

  it('destrói o ambiente atual do usuário e cria um provisório novo (id diferente)', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/v1/setup/environment' })).json()

    const res = await app.inject({ method: 'POST', url: '/api/v1/setup/environment/reset' })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('provisional')
    expect(body.id).toBeTruthy()
    expect(body.id).not.toBe(created.id)
    // o dir antigo sumiu; nenhum path interno vaza na resposta
    await expect(fs.stat(path.join(baseDir, created.id))).rejects.toThrow()
    expect(JSON.stringify(body)).not.toContain(baseDir)
  })

  it('usuário sem ambiente algum -> só cria (não quebra por falta do que destruir)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/setup/environment/reset' })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('provisional')
  })

  it('nunca toca o ambiente de outro usuário', async () => {
    const prisma = (app as any).prisma
    prisma.store.set('env_alheio', {
      id: 'env_alheio',
      userId: 'user_2',
      status: 'provisional',
      path: path.join(baseDir, 'env_alheio'),
      createdAt: new Date(),
    })
    await fs.mkdir(path.join(baseDir, 'env_alheio'), { recursive: true })

    await app.inject({ method: 'POST', url: '/api/v1/setup/environment/reset' })

    expect(prisma.store.has('env_alheio')).toBe(true)
    await expect(fs.stat(path.join(baseDir, 'env_alheio'))).resolves.toBeTruthy()
  })
})

describe('POST /api/v1/setup/environment/reset — sem sessão', () => {
  it('retorna 401 sem destruir nem criar nada', async () => {
    const app = Fastify()
    app.decorate('prisma', fakePrisma() as any)
    await setupRoutes(app)
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/api/v1/setup/environment/reset' })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})
