import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ClientEnvironmentService } from './environment.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
// Fake do Prisma para a tabela client_environments: store em memória com os
// 3 métodos que o serviço usa. Mesmo padrão de engine-connection.test.ts.
function fakePrisma() {
  const store = new Map<string, any>()
  let seq = 0
  return {
    store,
    clientEnvironment: {
      findFirst: vi.fn(async ({ where, orderBy }: any) => {
        let rows = [...store.values()].filter(
          (r) => r.userId === where.userId && r.status === where.status
        )
        if (orderBy?.createdAt === 'desc') {
          rows = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        }
        return rows[0] ?? null
      }),
      create: vi.fn(async ({ data }: any) => {
        const now = new Date()
        const rec = { id: `env_${++seq}`, fixedAt: null, createdAt: now, updatedAt: now, ...data }
        store.set(rec.id, rec)
        return rec
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const rec = { ...store.get(where.id), ...data, updatedAt: new Date() }
        store.set(where.id, rec)
        return rec
      }),
    },
  }
}

describe('ClientEnvironmentService.createProvisional', () => {
  let baseDir: string
  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-envtest-'))
  })
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true })
  })

  test('cria ambiente provisional com diretório exclusivo, só para o dono (0700)', async () => {
    const prisma = fakePrisma()
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    const env = await svc.createProvisional('user_1')

    expect(env.status).toBe('provisional')
    expect(env.userId).toBe('user_1')
    expect(env.path).toBe(path.join(baseDir, env.id))
    const stat = await fs.stat(env.path)
    expect(stat.isDirectory()).toBe(true)
    // group e other não podem ter NENHUM acesso (guarda credenciais do cliente)
    expect(stat.mode & 0o077).toBe(0)
  })

  test('idempotente: segunda chamada reusa o provisional aberto (não multiplica ambiente)', async () => {
    const prisma = fakePrisma()
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    const a = await svc.createProvisional('user_1')
    const b = await svc.createProvisional('user_1')

    expect(b.id).toBe(a.id)
    expect(prisma.clientEnvironment.create).toHaveBeenCalledTimes(1)
  })

  test('usuários diferentes recebem ambientes isolados distintos', async () => {
    const prisma = fakePrisma()
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    const a = await svc.createProvisional('user_1')
    const b = await svc.createProvisional('user_2')

    expect(b.id).not.toBe(a.id)
    expect(b.path).not.toBe(a.path)
  })
})

describe('ClientEnvironmentService.cloneInto', () => {
  test('clona cada repo no ambiente, reusando o provider com o token do cliente', async () => {
    const prisma = fakePrisma()
    const allocateWorkspace = vi.fn(async (envId: string, repo: string) => ({
      id: `ws:${envId}:${repo}`,
      userId: envId,
      projectId: repo,
      path: `/base/${envId}/${repo.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      status: 'active' as const,
    }))
    const svc = new ClientEnvironmentService(prisma as any, '/base', { allocateWorkspace })

    const result = await svc.cloneInto('env_1', ['octo/repo-a', 'octo/repo-b'], 'tok_123')

    expect(allocateWorkspace).toHaveBeenCalledTimes(2)
    expect(allocateWorkspace).toHaveBeenCalledWith('env_1', 'octo/repo-a', {
      repository: 'octo/repo-a',
      token: 'tok_123',
    })
    expect(result.map((r) => r.repo)).toEqual(['octo/repo-a', 'octo/repo-b'])
    // clonado dentro do ambiente (envId no caminho)
    expect(result[0]!.path).toContain('env_1')
  })

  test('sem repos selecionados não chama o provider (nada a clonar)', async () => {
    const prisma = fakePrisma()
    const allocateWorkspace = vi.fn()
    const svc = new ClientEnvironmentService(prisma as any, '/base', { allocateWorkspace })

    const result = await svc.cloneInto('env_1', [])

    expect(allocateWorkspace).not.toHaveBeenCalled()
    expect(result).toEqual([])
  })
})

describe('ClientEnvironmentService.repoPathInEnv', () => {
  let baseDir: string
  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-repopath-'))
  })
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true })
  })

  test('retorna o path do clone quando o repo já existe no ambiente (reuso)', async () => {
    const prisma = fakePrisma()
    const envPath = path.join(baseDir, 'env_1')
    await fs.mkdir(path.join(envPath, 'octo_repo', '.git'), { recursive: true })
    prisma.store.set('env_1', {
      id: 'env_1',
      userId: 'user_1',
      status: 'provisional',
      path: envPath,
      createdAt: new Date(),
    })
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    const p = await svc.repoPathInEnv('user_1', 'octo/repo')

    expect(p).toBe(path.join(envPath, 'octo_repo'))
  })

  test('retorna null quando o repo ainda não foi clonado', async () => {
    const prisma = fakePrisma()
    const envPath = path.join(baseDir, 'env_1')
    await fs.mkdir(envPath, { recursive: true })
    prisma.store.set('env_1', {
      id: 'env_1',
      userId: 'user_1',
      status: 'provisional',
      path: envPath,
      createdAt: new Date(),
    })
    const svc = new ClientEnvironmentService(prisma as any, baseDir)

    expect(await svc.repoPathInEnv('user_1', 'octo/repo')).toBeNull()
  })

  test('retorna null quando o usuário não tem ambiente', async () => {
    const prisma = fakePrisma()
    const svc = new ClientEnvironmentService(prisma as any, baseDir)
    expect(await svc.repoPathInEnv('user_1', 'octo/repo')).toBeNull()
  })
})
