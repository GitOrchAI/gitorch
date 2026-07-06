import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { EngineConnectionService } from './engine-connection.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
function fakePrisma() {
  const store = new Map<string, Record<string, unknown>>()
  const key = (userId: string, runtime: string) => `${userId}:${runtime}`
  return {
    store,
    engineConnection: {
      upsert: vi.fn(async ({ where, update, create }: any) => {
        const k = key(where.userId_runtime.userId, where.userId_runtime.runtime)
        const existing = store.get(k)
        const rec = existing
          ? { ...existing, ...update }
          : {
              modelsRefreshedAt: null,
              lastValidatedAt: null,
              lastError: null,
              ...create,
            }
        store.set(k, rec)
        return rec
      }),
      findUnique: vi.fn(
        async ({ where }: any) =>
          store.get(key(where.userId_runtime.userId, where.userId_runtime.runtime)) ?? null
      ),
      findMany: vi.fn(async ({ where }: any) =>
        [...store.values()].filter((r) => r['userId'] === where.userId)
      ),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const k = key(where.userId, where.runtime)
        const existing = store.get(k)
        if (existing) store.set(k, { ...existing, ...data })
        return { count: existing ? 1 : 0 }
      }),
    },
  }
}

describe('EngineConnectionService', () => {
  const originalKey = process.env['GITORCH_CREDENTIAL_KEY']
  beforeEach(() => {
    process.env['GITORCH_CREDENTIAL_KEY'] = randomBytes(32).toString('hex')
  })
  afterEach(() => {
    if (originalKey === undefined) delete process.env['GITORCH_CREDENTIAL_KEY']
    else process.env['GITORCH_CREDENTIAL_KEY'] = originalKey
  })

  test('captura de um HOME, cifra e restaura em outro HOME (round-trip do cliente)', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)

    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-home-'))
    await fs.mkdir(path.join(home, '.codex'), { recursive: true })
    await fs.writeFile(path.join(home, '.codex', 'auth.json'), '{"token":"do-cliente"}')
    // arquivo fora dos caminhos de credencial (histórico/log) NÃO é capturado
    await fs.writeFile(path.join(home, '.codex', 'history.log'), 'x'.repeat(1000))

    const status = await svc.captureFromHome('user_1', 'codex', home)
    expect(status.status).toBe('connected')
    // credencial guardada NÃO é texto puro
    const stored = prisma.store.get('user_1:codex')
    expect(String(stored?.['encryptedCredential'])).not.toContain('do-cliente')

    const missionHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-mhome-'))
    const ok = await svc.materializeToHome('user_1', 'codex', missionHome)
    expect(ok).toBe(true)
    expect(await fs.readFile(path.join(missionHome, '.codex', 'auth.json'), 'utf8')).toBe(
      '{"token":"do-cliente"}'
    )
    // arquivo não listado (history.log) não foi capturado nem restaurado
    await expect(fs.stat(path.join(missionHome, '.codex', 'history.log'))).rejects.toThrow()

    await fs.rm(home, { recursive: true, force: true })
    await fs.rm(missionHome, { recursive: true, force: true })
  })

  test('materialize retorna false sem conexão e após revoke', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-home2-'))

    expect(await svc.materializeToHome('user_x', 'codex', home)).toBe(false)

    await fs.mkdir(path.join(home, '.codex'), { recursive: true })
    await fs.writeFile(path.join(home, '.codex', 'auth.json'), '{}')
    await svc.captureFromHome('user_x', 'codex', home)
    await svc.revoke('user_x', 'codex')
    expect(await svc.materializeToHome('user_x', 'codex', home)).toBe(false)

    await fs.rm(home, { recursive: true, force: true })
  })

  test('captura falha com runtime não suportado e sem credencial no HOME', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-home3-'))

    await expect(svc.captureFromHome('u', 'inexistente', home)).rejects.toThrow('não suportado')
    await expect(svc.captureFromHome('u', 'claude', home)).rejects.toThrow('não encontrada')

    await fs.rm(home, { recursive: true, force: true })
  })

  test('connectGitHubToken cifra o PAT e materializa como .gitorch/gh-token 0600', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)

    const status = await svc.connectGitHubToken('user_gh', 'github_pat_FAKE_abc123')
    expect(status.runtime).toBe('github')
    expect(status.status).toBe('connected')

    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-ghhome-'))
    expect(await svc.materializeToHome('user_gh', 'github', home)).toBe(true)
    const tokenPath = path.join(home, '.gitorch', 'gh-token')
    expect((await fs.readFile(tokenPath, 'utf8')).trim()).toBe('github_pat_FAKE_abc123')
    const mode = (await fs.stat(tokenPath)).mode & 0o777
    expect(mode).toBe(0o600)

    await fs.rm(home, { recursive: true, force: true })
  })

  test('connectGitHubToken rejeita token vazio ou com formato estranho', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)
    await expect(svc.connectGitHubToken('u', '')).rejects.toThrow('token')
    await expect(svc.connectGitHubToken('u', 'senha com espaço\n')).rejects.toThrow('token')
  })

  test('getRawGithubToken devolve o token em texto puro (uso server-side, nunca no disco do host)', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)

    await svc.connectGitHubToken('user_gh2', 'github_pat_ROUNDTRIP_xyz')
    const token = await svc.getRawGithubToken('user_gh2')
    expect(token).toBe('github_pat_ROUNDTRIP_xyz')
  })

  test('getRawGithubToken devolve null quando não há conexão', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)
    expect(await svc.getRawGithubToken('user_sem_conexao')).toBeNull()
  })

  test('connectRawToken (claude setup-token) materializa como env var, não como arquivo de config', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)

    const status = await svc.connectRawToken('user_claude', 'claude', 'sk-ant-oat01-FAKE', {
      envVarName: 'CLAUDE_CODE_OAUTH_TOKEN',
    })
    expect(status.runtime).toBe('claude')
    expect(status.status).toBe('connected')

    const stored = prisma.store.get('user_claude:claude')
    expect(stored?.['credentialKind']).toBe('env')
    expect(stored?.['envVarName']).toBe('CLAUDE_CODE_OAUTH_TOKEN')
    // credencial guardada não é texto puro
    expect(String(stored?.['encryptedCredential'])).not.toContain('sk-ant-oat01-FAKE')

    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-claudehome-'))
    expect(await svc.materializeToHome('user_claude', 'claude', home)).toBe(true)
    const tokenPath = path.join(home, '.gitorch', 'env', 'CLAUDE_CODE_OAUTH_TOKEN')
    expect((await fs.readFile(tokenPath, 'utf8')).trim()).toBe('sk-ant-oat01-FAKE')
    const mode = (await fs.stat(tokenPath)).mode & 0o777
    expect(mode).toBe(0o600)

    await fs.rm(home, { recursive: true, force: true })
  })

  test('connectRawToken rejeita token vazio ou com espaço', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)
    await expect(
      svc.connectRawToken('u', 'claude', '', { envVarName: 'CLAUDE_CODE_OAUTH_TOKEN' })
    ).rejects.toThrow('token')
    await expect(
      svc.connectRawToken('u', 'claude', 'com espaço\n', { envVarName: 'CLAUDE_CODE_OAUTH_TOKEN' })
    ).rejects.toThrow('token')
  })

  test('connectFileCredential grava o conteúdo colado no caminho primário do runtime (codex auth.json)', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)

    const authJson = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'FAKE' } })
    const status = await svc.connectFileCredential('user_codex', 'codex', authJson)
    expect(status.status).toBe('connected')

    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-codexhome-'))
    expect(await svc.materializeToHome('user_codex', 'codex', home)).toBe(true)
    expect(await fs.readFile(path.join(home, '.codex', 'auth.json'), 'utf8')).toBe(authJson)

    await fs.rm(home, { recursive: true, force: true })
  })

  test('connectFileCredential grava o token do antigravity no caminho primário', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)

    const status = await svc.connectFileCredential('user_ag', 'antigravity', 'oauth-token-fake')
    expect(status.status).toBe('connected')

    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-aghome-'))
    expect(await svc.materializeToHome('user_ag', 'antigravity', home)).toBe(true)
    expect(
      await fs.readFile(
        path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
        'utf8'
      )
    ).toBe('oauth-token-fake')

    await fs.rm(home, { recursive: true, force: true })
  })

  test('connectFileCredential rejeita conteúdo vazio', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)
    await expect(svc.connectFileCredential('u', 'codex', '')).rejects.toThrow('vazia')
  })

  test('connectFileCredential rejeita runtime não suportado', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)
    await expect(svc.connectFileCredential('u', 'inexistente', 'x')).rejects.toThrow(
      'não suportado'
    )
  })
})
