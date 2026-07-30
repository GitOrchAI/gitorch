import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

// Mocka o provider de workspace: no teste o clone NÃO faz git real.
const allocateWorkspace = vi.fn(async (envId: string, repo: string) => ({
  id: `ws:${envId}:${repo}`,
  userId: envId,
  projectId: repo,
  path: `/base/${envId}/${repo.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
  status: 'active' as const,
}))
vi.mock('@gitorch/workspace-engine', () => ({
  LocalWorkspaceProvider: class {
    allocateWorkspace = allocateWorkspace
  },
}))

import { setupRoutes } from './setup.js'
import { ClientEnvironmentService } from '../services/environment.js'

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
    // A rota /clone agora lê o plano REAL do usuário (User.planId +
    // Plan.maxProjects) pra o teto de repos — anti-burla. Estes testes cobrem o
    // COMPORTAMENTO do clone (o limite em si é testado em setup.test.ts), então
    // o plano aqui é permissivo pra nunca bloquear a seleção sob teste.
    user: { findUnique: vi.fn(async () => ({ planId: 'free' })) },
    plan: { findUnique: vi.fn(async () => ({ maxProjects: 50 })) },
  }
}

describe('POST /api/v1/setup/clone', () => {
  let app: ReturnType<typeof Fastify>
  let baseDir: string
  const orig = process.env['GITORCH_ENVIRONMENTS_DIR']

  beforeEach(async () => {
    allocateWorkspace.mockClear()
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-clone-'))
    process.env['GITORCH_ENVIRONMENTS_DIR'] = baseDir
    app = Fastify()
    app.decorate('prisma', fakePrisma() as any)
    app.decorate('engineConnections', {
      getRawGithubToken: vi.fn().mockResolvedValue('tok_do_cliente'),
    } as any)
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

  it('clona os repos dentro do ambiente e responde só a contagem (sem paths internos)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/clone',
      payload: { repos: ['octo/a', 'octo/b'] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.count).toBe(2)
    expect(body.envId).toBeTruthy()
    // Regra de infra: nenhum caminho interno em disco na resposta.
    expect(JSON.stringify(body)).not.toContain('/base/')
    expect(allocateWorkspace).toHaveBeenCalledTimes(2)
  })

  it('400 quando nenhum repositório é enviado', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/clone',
      payload: { repos: [] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('clone falho: nunca um 500 cru — responde {error, code} classificado (contrato de erro)', async () => {
    allocateWorkspace.mockRejectedValueOnce(
      new Error(
        'Command failed: git clone --depth 1 -- https://github.com/octo/sumiu.git /base\n' +
          "Cloning into '/base'...\n" +
          'remote: Repository not found.\n' +
          "fatal: repository 'https://github.com/octo/sumiu.git/' not found\n"
      )
    )
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/clone',
      payload: { repos: ['octo/sumiu'] },
    })
    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.code).toBe('REPO_NOT_FOUND')
    expect(body.error).toBeTruthy()
    // Nenhum caminho interno de disco nem stack cru vazado na resposta.
    expect(JSON.stringify(body)).not.toContain('/base/')
  })

  it('timeout de clone -> 504 com code CLONE_TIMEOUT', async () => {
    allocateWorkspace.mockRejectedValueOnce(
      Object.assign(new Error('Command failed: git clone ...\n'), {
        killed: true,
        signal: 'SIGTERM',
      })
    )
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/clone',
      payload: { repos: ['octo/lento'] },
    })
    expect(res.statusCode).toBe(504)
    expect(res.json().code).toBe('CLONE_TIMEOUT')
  })

  // Correção do bug de TIMING (W1): o dono testou até o passo 7 (conectar
  // motores) e nunca chegou no submit (passo 10) — como bootstrapResources()
  // só disparava lá, o ambiente dele nunca teve os recursos instalados. Agora
  // dispara aqui, no clone (passo 4/5), bem mais cedo no funil.
  it('clone bem-sucedido dispara bootstrapResources (recursos versionados) no ambiente, sem esperar por ele', async () => {
    const bootstrapSpy = vi
      .spyOn(ClientEnvironmentService.prototype, 'bootstrapResources')
      .mockResolvedValue({ ok: true, lock: {} })

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/clone',
      payload: { repos: ['octo/a'] },
    })

    expect(res.statusCode).toBe(200)
    const envId = res.json().envId as string
    // Fire-and-forget: dá um tick de microtask pro disparo encadear antes de
    // checar a spy (a resposta HTTP não espera pelo bootstrap).
    await new Promise((resolve) => setImmediate(resolve))
    expect(bootstrapSpy).toHaveBeenCalledTimes(1)
    expect(bootstrapSpy).toHaveBeenCalledWith(envId)

    bootstrapSpy.mockRestore()
  })

  it('bootstrap falhando no clone NÃO derruba a resposta HTTP (fire-and-forget de verdade)', async () => {
    const bootstrapSpy = vi
      .spyOn(ClientEnvironmentService.prototype, 'bootstrapResources')
      .mockRejectedValue(new Error('boom: script quebrou'))

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/clone',
      payload: { repos: ['octo/a'] },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().count).toBe(1)
    // dá tempo do .catch() interno da rota engolir a rejeição (senão vira
    // unhandled rejection no processo de teste)
    await new Promise((resolve) => setImmediate(resolve))

    bootstrapSpy.mockRestore()
  })
})

describe('POST /api/v1/setup/clone — sem sessão', () => {
  it('retorna 401 sem clonar', async () => {
    const app = Fastify()
    app.decorate('prisma', fakePrisma() as any)
    await setupRoutes(app)
    await app.ready()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/clone',
      payload: { repos: ['a/b'] },
    })
    expect(res.statusCode).toBe(401)
    await app.close()
  })
})
