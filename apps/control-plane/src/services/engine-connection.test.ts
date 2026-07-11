import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { EngineConnectionService, isSupportedRuntime } from './engine-connection.js'

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

// Liveness fake: reporta o motor vivo. Os testes de captura validam o
// ARMAZENAMENTO da credencial, não a validação viva (coberta em
// engine-liveness.test.ts). Sem isto, o liveness real rodaria o CLI do motor.
const aliveLiveness = async () => ({
  alive: true as const,
  models: [] as string[],
  quota: { remaining: null as number | null, total: null as number | null },
})

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
    // Este teste valida ARMAZENAMENTO da credencial, não liveness — aliveLiveness
    // evita rodar o CLI real do codex (ausente no runner de CI; presente só
    // nesta VM de dev, onde o teste passaria por acaso e mascararia o problema).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any, aliveLiveness)

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
    const svc = new EngineConnectionService(prisma as any, aliveLiveness)
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

  test('getRawGithubToken segue funcionando após parar de materializar em disco (round-trip via readArchiveEntry)', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)
    await svc.connectGitHubToken('user_gh3', 'github_pat_NO_DISK_xyz')
    expect(await svc.getRawGithubToken('user_gh3')).toBe('github_pat_NO_DISK_xyz')
  })

  test('connectRawToken (claude setup-token) materializa como env var, não como arquivo de config', async () => {
    const prisma = fakePrisma()
    // Mesmo motivo do teste de captura acima: valida armazenamento, não
    // liveness — sem o fake, rodaria `claude auth status` de verdade.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any, aliveLiveness)

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

  test('materializeToHome trata uma conexão com expiresAt no passado como desconectada', async () => {
    const prisma = fakePrisma()
    // aliveLiveness garante que o status vira 'connected' na captura — sem
    // isto, num ambiente sem o CLI do claude, o status já cairia em 'error'
    // por liveness (não pela expiração), e o teste passaria pelo motivo
    // ERRADO (mascarando a checagem real de expiresAt).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any, aliveLiveness)

    await svc.connectRawToken('user_expired', 'claude', 'sk-ant-oat01-FAKE', {
      envVarName: 'CLAUDE_CODE_OAUTH_TOKEN',
      expiresAt: new Date(Date.now() - 1000),
    })

    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-expiredhome-'))
    expect(await svc.materializeToHome('user_expired', 'claude', home)).toBe(false)
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

  test('connectRawToken rejeita envVarName que tentaria escapar do diretório .gitorch/env (path traversal)', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)
    await expect(
      svc.connectRawToken('u', 'claude', 'sk-fake', { envVarName: '../../../../etc/cron.d/evil' })
    ).rejects.toThrow('envVarName')
    await expect(
      svc.connectRawToken('u', 'claude', 'sk-fake', { envVarName: 'FOO/BAR' })
    ).rejects.toThrow('envVarName')
  })

  test('connectFileCredential grava o conteúdo colado no caminho primário do runtime (codex auth.json)', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any, aliveLiveness)

    const authJson = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'FAKE' } })
    const status = await svc.connectFileCredential('user_codex', 'codex', authJson)
    expect(status.status).toBe('connected')

    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-codexhome-'))
    expect(await svc.materializeToHome('user_codex', 'codex', home)).toBe(true)
    expect(await fs.readFile(path.join(home, '.codex', 'auth.json'), 'utf8')).toBe(authJson)

    await fs.rm(home, { recursive: true, force: true })
  })

  test('captureFromHome marca "error" (não connected) quando o motor não responde à validação viva', async () => {
    const prisma = fakePrisma()
    const deadLiveness = async () => ({
      alive: false as const,
      models: [] as string[],
      quota: { remaining: null as number | null, total: null as number | null },
      error: 'Not logged in',
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any, deadLiveness)

    const status = await svc.connectFileCredential(
      'user_dead',
      'codex',
      JSON.stringify({ tokens: {} })
    )
    expect(status.status).toBe('error')
    expect(status.lastError).toContain('Not logged in')
    // a credencial FICA guardada (cifrada) pra reconectar sem recolar
    expect(prisma.store.get('user_dead:codex')?.['encryptedCredential']).toBeTruthy()
  })

  test('github NÃO passa por validação viva (não é motor) — conecta direto', async () => {
    const prisma = fakePrisma()
    let livenessCalled = false
    const spyLiveness = async () => {
      livenessCalled = true
      return {
        alive: false as const,
        models: [] as string[],
        quota: { remaining: null as number | null, total: null as number | null },
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any, spyLiveness)

    const status = await svc.connectGitHubToken('user_gh', 'ghp_faketoken')
    expect(status.status).toBe('connected')
    expect(livenessCalled).toBe(false)
  })

  test('connectFileCredential grava o token do antigravity no caminho primário', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any, aliveLiveness)

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

  test('connectFileCredential rejeita conteúdo do Codex que não é JSON válido (auth.json tem que ser JSON)', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)
    await expect(
      svc.connectFileCredential('u', 'codex', 'isto claramente não é JSON')
    ).rejects.toThrow('JSON')
  })

  test('connectFileCredential rejeita runtime não suportado', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)
    await expect(svc.connectFileCredential('u', 'inexistente', 'x')).rejects.toThrow(
      'não suportado'
    )
  })

  // Achado real do CodeQL (unvalidated dynamic method call): ENGINE_CREDENTIAL_PATHS
  // e MODEL_DISCOVERERS/QUOTA_READERS são objetos-literais, que herdam de
  // Object.prototype. Um `runtime` como 'constructor' (input de cliente, vindo
  // de params de rota sem tipo restrito) resolve para uma função HERDADA do
  // protótipo — verdadeira em `in`/checagem de falsy — escapando do guard "não
  // suportado" e sendo tratada como config/função real de motor mais adiante.
  // Object.hasOwn fecha essa classe inteira de bypass.
  test('runtime = "constructor" (ou outra propriedade herdada de Object.prototype) é rejeitado como não suportado, não escapa via prototype pollution', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)

    expect(isSupportedRuntime('constructor')).toBe(false)
    expect(isSupportedRuntime('toString')).toBe(false)
    expect(isSupportedRuntime('hasOwnProperty')).toBe(false)

    await expect(svc.connectFileCredential('u', 'constructor', 'x')).rejects.toThrow(
      'não suportado'
    )
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-proto-'))
    await expect(svc.captureFromHome('u', 'constructor', home)).rejects.toThrow('não suportado')
    expect(await svc.materializeToHome('u', 'constructor', home)).toBe(false)
    expect(await svc.refreshModels('u', 'constructor')).toEqual([])

    await fs.rm(home, { recursive: true, force: true })
  })
})
