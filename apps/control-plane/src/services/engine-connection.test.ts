import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { EngineConnectionService, isSupportedRuntime } from './engine-connection.js'
import { MODEL_DISCOVERERS } from './model-catalog.js'

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
        [...store.values()].filter((r) => {
          if (r['userId'] !== where.userId) return false
          // Honra `runtime: { not: 'x' }` como o Prisma real — é o filtro que
          // mantém a linha do github FORA da listagem de motores.
          if (where.runtime?.not !== undefined && r['runtime'] === where.runtime.not) return false
          return true
        })
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

  // A listagem é de MOTORES. A linha 'github' mora na MESMA tabela (o cofre
  // cifrado é reusado), mas github NÃO é motor: entra pelo OAuth já 'connected',
  // sem liveness. Misturada aos motores de IA, ela confundia a UI — e era um dos
  // pés da tautologia que fazia o passo final do wizard cantar vitória cedo.
  test('list() devolve só os motores de IA — a linha do github nunca aparece', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any, aliveLiveness)
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-list-'))
    await fs.mkdir(path.join(home, '.codex'), { recursive: true })
    await fs.writeFile(path.join(home, '.codex', 'auth.json'), '{"token":"do-cliente"}')

    await svc.captureFromHome('user_1', 'codex', home)
    await svc.connectGitHubToken('user_1', 'ghp_token_do_cliente')

    // as duas linhas existem no cofre...
    expect(prisma.store.has('user_1:codex')).toBe(true)
    expect(prisma.store.has('user_1:github')).toBe(true)
    // ...mas só o motor de IA é listado como motor
    const list = await svc.list('user_1')
    expect(list.map((c) => c.runtime)).toEqual(['codex'])

    await fs.rm(home, { recursive: true, force: true })
  })

  test('excluir o github da lista NÃO quebra quem depende dele (o token segue acessível)', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any, aliveLiveness)

    await svc.connectGitHubToken('user_1', 'ghp_token_do_cliente')

    // a porta certa pro github é esta (usada por /github/repos e pelo scheduler)
    expect(await svc.getRawGithubToken('user_1')).toBe('ghp_token_do_cliente')
    expect(await svc.list('user_1')).toEqual([])
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
    if (process.platform !== 'win32') {
      const mode = (await fs.stat(tokenPath)).mode & 0o777
      expect(mode).toBe(0o600)
    }

    await fs.rm(home, { recursive: true, force: true })
  })

  test('connectGitHubToken com refresh token: guarda encryptedRefreshToken cifrado (nunca texto puro) e expiresAt', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)

    const expiresAt = new Date(Date.now() + 8 * 3600 * 1000)
    const refreshTokenExpiresAt = new Date('2027-02-13T12:00:00Z')
    await svc.connectGitHubToken('user_refresh', 'gh_access_novo', {
      refreshToken: 'gh_refresh_novo',
      expiresAt,
      refreshTokenExpiresAt,
    })

    const stored = prisma.store.get('user_refresh:github')
    expect(stored?.['expiresAt']).toEqual(expiresAt)
    expect(stored?.['refreshTokenExpiresAt']).toEqual(refreshTokenExpiresAt)
    expect(String(stored?.['encryptedRefreshToken'])).not.toBe('gh_refresh_novo')
    expect(String(stored?.['encryptedRefreshToken']).length).toBeGreaterThan(0)

    // o restaurado na missão continua sendo SÓ o access token — o refresh
    // token nunca vai para o HOME de uma missão.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-ghrefresh-'))
    expect(await svc.materializeToHome('user_refresh', 'github', home)).toBe(true)
    expect((await fs.readFile(path.join(home, '.gitorch', 'gh-token'), 'utf8')).trim()).toBe(
      'gh_access_novo'
    )
    await expect(fs.stat(path.join(home, '.gitorch', 'refresh-token'))).rejects.toThrow()
    await fs.rm(home, { recursive: true, force: true })
  })

  test('revoke() limpa o cartão de renovação junto com a credencial (refresh token não sobrevive à revogação)', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)

    await svc.connectGitHubToken('user_revoke_refresh', 'gh_access_velho', {
      refreshToken: 'gh_refresh_velho',
      refreshTokenExpiresAt: new Date('2027-02-13T12:00:00Z'),
    })
    await svc.revoke('user_revoke_refresh', 'github')

    // Cenário real: o cliente reconecta colando só um access token novo, sem
    // cartão de renovação (connectGitHubToken usa spread condicional — sem
    // este teste, o refresh token ANTIGO sobreviveria à revogação e a
    // renovação periódica tentaria usá-lo, órfão, contra um access token
    // que não tem nenhuma relação com ele).
    const stored = prisma.store.get('user_revoke_refresh:github')
    expect(stored?.['encryptedRefreshToken']).toBeNull()
    expect(stored?.['refreshTokenExpiresAt']).toBeNull()
  })

  test('materializeToHome recusa uma conexão marcada needs_reconnect, mesmo com expiresAt no futuro', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any)
    await svc.connectGitHubToken('user_stuck', 'gh_access_velho')
    // renovação falhou no GitHub: o status vira needs_reconnect (mesma
    // gravação que scheduler.ts faz em marcarPrecisaReconectar, Task 5)
    await prisma.engineConnection.updateMany({
      where: { userId: 'user_stuck', runtime: 'github' },
      data: { status: 'needs_reconnect', lastError: 'refresh token revogado' },
    })

    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-ghstuck-'))
    expect(await svc.materializeToHome('user_stuck', 'github', home)).toBe(false)
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
    if (process.platform !== 'win32') {
      const mode = (await fs.stat(tokenPath)).mode & 0o777
      expect(mode).toBe(0o600)
    }

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

    // O payload passa a validação de FORMA (tem tokens.access_token) e chega na
    // liveness — que aqui (stub deadLiveness) reprova. É o cenário "credencial
    // com forma de real, mas o motor não respondeu": guarda e marca 'error'.
    const status = await svc.connectFileCredential(
      'user_dead',
      'codex',
      JSON.stringify({ tokens: { access_token: 'aaa.bbb.ccc' } })
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

  // ───────────────────────────────────────────────────────────────────────────
  // Regressão anti-fachada (QA 2026-07-13): credencial colada grosseiramente
  // FALSA não pode virar 'connected'. Os CLIs reais MENTEM — `codex login status`
  // e `claude auth status` respondem exit 0 "logado" para JSON lixo parseável /
  // token não-vazio (reproduzido de verdade nesta VM). Por isso a rejeição TEM que
  // vir ANTES da liveness. Nos testes abaixo a liveness é um espião que SEMPRE
  // diria alive:true (simula o CLI mentiroso): se o fix regredir, o motor viraria
  // 'connected' — exatamente o proibido. `called===false` prova que barramos na porta.
  function spyAliveLiveness() {
    const state = { called: false }
    const liveness = async () => {
      state.called = true
      return {
        alive: true as const,
        models: [] as string[],
        quota: { remaining: null as number | null, total: null as number | null },
      }
    }
    return { state, liveness }
  }

  test('connectFileCredential: codex com JSON falso NÃO vira connected, mesmo com a liveness mentindo (alive)', async () => {
    const prisma = fakePrisma()
    const { state, liveness } = spyAliveLiveness()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any, liveness)

    await expect(
      svc.connectFileCredential('user_fake', 'codex', '{"fake":"qualquer coisa"}')
    ).rejects.toThrow(/codex inválida/)
    // barrado ANTES da liveness — o CLI mentiroso nunca foi consultado
    expect(state.called).toBe(false)
    // e nada foi persistido: não existe 'connected' nem 'error' meia-boca
    expect(prisma.store.get('user_fake:codex')).toBeUndefined()
  })

  test.each([
    ['objeto vazio', '{}'],
    ['tokens sem access_token', '{"tokens":{}}'],
  ])('connectFileCredential: codex %s é rejeitado e não persiste nada', async (_label, content) => {
    const prisma = fakePrisma()
    const { state, liveness } = spyAliveLiveness()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any, liveness)
    await expect(svc.connectFileCredential('u', 'codex', content)).rejects.toThrow(/codex inválida/)
    expect(state.called).toBe(false)
    expect(prisma.store.get('u:codex')).toBeUndefined()
  })

  test('connectFileCredential: codex com forma real (tokens.access_token) conecta', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any, aliveLiveness)
    const status = await svc.connectFileCredential(
      'user_ok',
      'codex',
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'aaa.bbb.ccc' } })
    )
    expect(status.status).toBe('connected')
  })

  test('connectRawToken: claude com token lixo NÃO vira connected, mesmo com a liveness mentindo', async () => {
    const prisma = fakePrisma()
    const { state, liveness } = spyAliveLiveness()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any, liveness)
    await expect(
      svc.connectRawToken('user_fk', 'claude', 'lixo-fake-token', {
        envVarName: 'CLAUDE_CODE_OAUTH_TOKEN',
      })
    ).rejects.toThrow(/claude inválido/)
    expect(state.called).toBe(false)
    expect(prisma.store.get('user_fk:claude')).toBeUndefined()
  })

  test('connectRawToken: claude com token do setup-token (sk-ant-oat...) conecta', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any, aliveLiveness)
    const status = await svc.connectRawToken('user_ok2', 'claude', 'sk-ant-oat01-abcdef123456', {
      envVarName: 'CLAUDE_CODE_OAUTH_TOKEN',
    })
    expect(status.status).toBe('connected')
  })

  test('connectFileCredential: antigravity continua entregue à liveness real (agy models faz o round-trip)', async () => {
    // Antigravity NÃO tem checagem de forma (formato indocumentado); o `agy models`
    // da liveness dele já reprova token falso ao vivo. Com deadLiveness, um token
    // qualquer vira 'error' (não connected) — pela liveness, não pela forma.
    const prisma = fakePrisma()
    const deadLiveness = async () => ({
      alive: false as const,
      models: [] as string[],
      quota: { remaining: null as number | null, total: null as number | null },
      error: 'Please sign in',
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any, deadLiveness)
    const status = await svc.connectFileCredential('user_ag2', 'antigravity', 'lixo')
    expect(status.status).toBe('error')
    expect(status.lastError).toContain('Please sign in')
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

  // Regressão do bug real do Codex (2026-07-20, diagnóstico
  // docs/superpowers/qa/2026-07-20-diagnostico-3-motores.md): a liveness do
  // Codex, ao descobrir modelos, pode aquecer e GRAVAR
  // `.codex/models_cache.json` no homeDir pela 1ª vez (ver makeCodexDiscoverer
  // em model-catalog.ts) — o arquivo não existia quando o login terminou.
  // Sem rearquivar DEPOIS da liveness, esse arquivo nunca entraria no blob
  // cifrado persistido, e toda missão completada teria que aquecer de novo.
  test('captureFromHome rearquiva a credencial depois da liveness (pega arquivo que a descoberta de modelos criou)', async () => {
    const prisma = fakePrisma()
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-home-warmup-'))
    await fs.mkdir(path.join(home, '.codex'), { recursive: true })
    await fs.writeFile(path.join(home, '.codex', 'auth.json'), '{"token":"do-cliente"}')

    // Simula o que a liveness real faz ao descobrir modelos do Codex: grava
    // models_cache.json no MESMO homeDir só DEPOIS que a 1ª arquivagem (a de
    // dentro de captureFromHome, antes da liveness) já rodou.
    const livenessQueAquece = async () => {
      await fs.writeFile(
        path.join(home, '.codex', 'models_cache.json'),
        JSON.stringify({ models: [{ slug: 'gpt-5.5' }] })
      )
      return {
        alive: true as const,
        models: ['gpt-5.5'],
        quota: { remaining: null as number | null, total: null as number | null },
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any, livenessQueAquece)

    const status = await svc.captureFromHome('user_warm', 'codex', home)
    expect(status.models).toEqual(['gpt-5.5'])

    // A credencial PERSISTIDA também tem que ter pego o cache recém-criado —
    // senão toda missão completada (refreshModels em scheduler.ts) teria que
    // aquecer de novo, gastando quota do dono à toa.
    const missionHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-mhome-warmup-'))
    expect(await svc.materializeToHome('user_warm', 'codex', missionHome)).toBe(true)
    expect(
      await fs.readFile(path.join(missionHome, '.codex', 'models_cache.json'), 'utf8')
    ).toContain('gpt-5.5')

    await fs.rm(home, { recursive: true, force: true })
    await fs.rm(missionHome, { recursive: true, force: true })
  })

  // O catálogo só é substituído por uma coleta que DEU CERTO, e o que sumiu
  // fica marcado em vez de sumir do registro. Os dois lados do mesmo defeito:
  // em 31/08 o provedor removeu a geração 3.5 e o produto não tinha onde
  // registrar isso — nem para escolher o modelo, nem para contar ao dono.
  const comCatalogoDoCodex = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    svc: any,
    userId: string,
    modelos: string[] | Error
  ) => {
    const original = MODEL_DISCOVERERS['codex']
    if (!original) throw new Error('setup do teste: MODEL_DISCOVERERS.codex ausente')
    MODEL_DISCOVERERS['codex'] = async () => {
      if (modelos instanceof Error) throw modelos
      return modelos
    }
    try {
      return await svc.refreshModels(userId, 'codex')
    } finally {
      MODEL_DISCOVERERS['codex'] = original
    }
  }

  const conectaCodex = async (userId: string) => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any, aliveLiveness)
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-cat-'))
    await fs.mkdir(path.join(home, '.codex'), { recursive: true })
    await fs.writeFile(path.join(home, '.codex', 'auth.json'), '{"token":"x"}')
    await svc.captureFromHome(userId, 'codex', home)
    await fs.rm(home, { recursive: true, force: true })
    return { prisma, svc }
  }

  test('o modelo que SAIU do catálogo fica marcado indisponível, com a data, e não é apagado', async () => {
    const { prisma, svc } = await conectaCodex('user_sumiu')
    await comCatalogoDoCodex(svc, 'user_sumiu', ['GPT-5.5', 'GPT-5.4-Mini'])
    await comCatalogoDoCodex(svc, 'user_sumiu', ['GPT-5.5'])

    const rec = prisma.store.get('user_sumiu:codex') as Record<string, unknown>
    expect(rec['models']).toEqual(['GPT-5.5'])
    const fora = rec['modelsUnavailable'] as Array<{ nome: string; sumiuEm: string }>
    expect(fora).toHaveLength(1)
    expect(fora[0]?.nome).toBe('GPT-5.4-Mini')
    expect(Date.parse(fora[0]?.sumiuEm as string)).not.toBeNaN()

    // E o painel precisa PODER dizer: sem isto o dado existe no banco e morre lá.
    const status = await svc.list('user_sumiu')
    expect(status[0]?.modelsUnavailable).toEqual(fora)
  })

  test('modelo que VOLTA some da lista de indisponíveis', async () => {
    const { prisma, svc } = await conectaCodex('user_voltou')
    await comCatalogoDoCodex(svc, 'user_voltou', ['GPT-5.5', 'GPT-5.4-Mini'])
    await comCatalogoDoCodex(svc, 'user_voltou', ['GPT-5.5'])
    await comCatalogoDoCodex(svc, 'user_voltou', ['GPT-5.5', 'GPT-5.4-Mini'])

    const rec = prisma.store.get('user_voltou:codex') as Record<string, unknown>
    expect(rec['modelsUnavailable']).toEqual([])
  })

  test('FAIL-CLOSED CONSCIENTE: coleta que FALHA não zera a lista boa nem marca ninguém como sumido', async () => {
    // A lista vazia por erro de rede seria o mesmo "default vazio que mente"
    // que já derrubou a esteira aqui. Coleta que falhou não prova ausência de
    // modelo nenhum.
    const { prisma, svc } = await conectaCodex('user_falha')
    await comCatalogoDoCodex(svc, 'user_falha', ['GPT-5.5', 'GPT-5.4-Mini'])
    const bom = prisma.store.get('user_falha:codex') as Record<string, unknown>
    const carimboBom = bom['modelsRefreshedAt']

    for (const falha of [[] as string[], new Error('rede fora do ar')]) {
      expect(await comCatalogoDoCodex(svc, 'user_falha', falha)).toEqual([])
      const rec = prisma.store.get('user_falha:codex') as Record<string, unknown>
      expect(rec['models']).toEqual(['GPT-5.5', 'GPT-5.4-Mini'])
      expect(rec['modelsUnavailable']).toEqual([])
      // "marca a data como VELHA": o carimbo de sucesso não avança.
      expect(rec['modelsRefreshedAt']).toBe(carimboBom)
      expect(String(rec['lastError'] ?? '')).not.toBe('')
    }
  })

  test('a TENTATIVA é carimbada mesmo quando falha — senão o relógio tenta de novo a cada minuto', async () => {
    const { prisma, svc } = await conectaCodex('user_tentou')
    // O connect já faz uma coleta viva e carimba o sucesso — por isso a
    // asserção é sobre o carimbo NÃO ANDAR, não sobre ele ser nulo.
    const antes = prisma.store.get('user_tentou:codex') as Record<string, unknown>
    const sucessoAntes = antes['modelsRefreshedAt']
    expect(antes['modelsCheckedAt'] ?? null).toBeNull()

    await comCatalogoDoCodex(svc, 'user_tentou', new Error('rede fora do ar'))
    const rec = prisma.store.get('user_tentou:codex') as Record<string, unknown>
    expect(rec['modelsCheckedAt']).toBeInstanceOf(Date)
    // E o carimbo de SUCESSO não andou: a coleta não aconteceu.
    expect(rec['modelsRefreshedAt']).toBe(sucessoAntes)
    expect(String(rec['lastError'] ?? '')).toContain('rede fora do ar')
  })

  test('refreshModels rearquiva a credencial com o que a descoberta grava no HOME (evita aquecer de novo em toda missão)', async () => {
    const prisma = fakePrisma()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new EngineConnectionService(prisma as any, aliveLiveness)
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-refresh-'))
    await fs.mkdir(path.join(home, '.codex'), { recursive: true })
    await fs.writeFile(path.join(home, '.codex', 'auth.json'), '{"token":"x"}')
    await svc.captureFromHome('user_refresh', 'codex', home)

    // Substitui o discoverer real do Codex por um fake que simula o
    // aquecimento: grava models_cache.json no HOME MATERIALIZADO (a prova de
    // que a descoberta aconteceu ali) e devolve os modelos. MODEL_DISCOVERERS
    // é um objeto-módulo mutável de propósito só para este teste (sem mock de
    // módulo), restaurado no finally.
    const originalDiscoverer = MODEL_DISCOVERERS['codex']
    if (!originalDiscoverer) throw new Error('setup do teste: MODEL_DISCOVERERS.codex ausente')
    MODEL_DISCOVERERS['codex'] = async (materializedHome: string) => {
      await fs.writeFile(
        path.join(materializedHome, '.codex', 'models_cache.json'),
        JSON.stringify({ models: [{ slug: 'gpt-5.5' }] })
      )
      return ['gpt-5.5']
    }
    try {
      const models = await svc.refreshModels('user_refresh', 'codex')
      expect(models).toEqual(['gpt-5.5'])
    } finally {
      MODEL_DISCOVERERS['codex'] = originalDiscoverer
    }

    // A credencial persistida tem que ter pego o cache — uma missão
    // subsequente (que restaura o blob salvo) já encontra o cache pronto, sem
    // precisar aquecer de novo.
    const missionHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-refresh-mission-'))
    expect(await svc.materializeToHome('user_refresh', 'codex', missionHome)).toBe(true)
    expect(
      await fs.readFile(path.join(missionHome, '.codex', 'models_cache.json'), 'utf8')
    ).toContain('gpt-5.5')

    await fs.rm(home, { recursive: true, force: true })
    await fs.rm(missionHome, { recursive: true, force: true })
  })
})
