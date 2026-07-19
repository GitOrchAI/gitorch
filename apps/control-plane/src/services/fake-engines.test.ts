import { describe, expect, test, afterEach, beforeEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { checkLiveness } from './engine-liveness.js'
import { ENGINE_CREDENTIAL_PATHS, EngineConnectionService } from './engine-connection.js'
import { AssistedLoginService, type LoginState } from './assisted-login.js'
import { extractClaudeToken } from '@gitorch/agents'
import {
  FAKE_LIVENESS_DEPS,
  FAKE_MODELS,
  FAKE_QUOTA,
  fakeEnginesEnabled,
  fakeRunDeviceLogin,
} from './fake-engines.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
function fakePrisma() {
  const store = new Map<string, Record<string, unknown>>()
  const key = (userId: string, runtime: string) => `${userId}:${runtime}`
  return {
    engineConnection: {
      upsert: vi.fn(async ({ where, update, create }: any) => {
        const k = key(where.userId_runtime.userId, where.userId_runtime.runtime)
        const existing = store.get(k)
        const rec = existing
          ? { ...existing, ...update }
          : { modelsRefreshedAt: null, lastValidatedAt: null, lastError: null, ...create }
        store.set(k, rec)
        return rec
      }),
      findUnique: vi.fn(
        async ({ where }: any) =>
          store.get(key(where.userId_runtime.userId, where.userId_runtime.runtime)) ?? null
      ),
    },
  }
}

const cleanupDirs: string[] = []

afterEach(async () => {
  for (const dir of cleanupDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
  delete process.env['GITORCH_FAKE_ENGINES']
  delete process.env['NODE_ENV']
})

describe('fakeEnginesEnabled', () => {
  test('desligado por padrão (sem env nenhuma)', () => {
    expect(fakeEnginesEnabled({})).toBe(false)
  })

  test('liga só com GITORCH_FAKE_ENGINES=1', () => {
    expect(fakeEnginesEnabled({ GITORCH_FAKE_ENGINES: '1' })).toBe(true)
    expect(fakeEnginesEnabled({ GITORCH_FAKE_ENGINES: 'true' })).toBe(false)
    expect(fakeEnginesEnabled({ GITORCH_FAKE_ENGINES: '0' })).toBe(false)
  })

  test('NUNCA liga em produção, mesmo com a flag setada — defesa em profundidade', () => {
    expect(fakeEnginesEnabled({ GITORCH_FAKE_ENGINES: '1', NODE_ENV: 'production' })).toBe(false)
    expect(fakeEnginesEnabled({ GITORCH_FAKE_ENGINES: '1', NODE_ENV: 'development' })).toBe(true)
  })
})

describe('FAKE_LIVENESS_DEPS via checkLiveness', () => {
  test.each(['antigravity', 'codex', 'claude'] as const)(
    '%s: alive com os modelos e a quota fakes determinísticos, sem rodar comando nenhum',
    async (runtime) => {
      const result = await checkLiveness(
        runtime,
        '/home/does-not-need-to-exist',
        FAKE_LIVENESS_DEPS
      )
      expect(result.alive).toBe(true)
      expect(result.error).toBeUndefined()
      expect(result.models).toEqual([...FAKE_MODELS])
      expect(result.quota).toEqual(FAKE_QUOTA)
    }
  )
})

describe('fakeRunDeviceLogin', () => {
  test('codex: sai com código 0 e deixa a credencial fake no caminho que ENGINE_CREDENTIAL_PATHS espera', async () => {
    const handle = fakeRunDeviceLogin({ image: 'unused', binary: 'codex', args: [] })
    cleanupDirs.push(handle.hostHome)

    const { code } = await handle.exited
    expect(code).toBe(0)

    const primaryPath = ENGINE_CREDENTIAL_PATHS['codex']?.[0] as string
    const written = await fs.readFile(`${handle.hostHome}/${primaryPath}`, 'utf8')
    expect(JSON.parse(written)).toMatchObject({ fake: true, runtime: 'codex' })
  })

  test('antigravity: mesmo contrato (bin "agy" resolve pro runtime antigravity)', async () => {
    const handle = fakeRunDeviceLogin({ image: 'unused', binary: 'agy', args: [] })
    cleanupDirs.push(handle.hostHome)

    const { code } = await handle.exited
    expect(code).toBe(0)

    const primaryPath = ENGINE_CREDENTIAL_PATHS['antigravity']?.[0] as string
    const written = await fs.readFile(`${handle.hostHome}/${primaryPath}`, 'utf8')
    expect(JSON.parse(written)).toMatchObject({ fake: true, runtime: 'antigravity' })
  })

  test('claude: emite via stdout um token que extractClaudeToken (o parser REAL) reconhece', async () => {
    const handle = fakeRunDeviceLogin({ image: 'unused', binary: 'claude', args: [] })
    cleanupDirs.push(handle.hostHome)

    const chunks: string[] = []
    handle.onStdout((chunk) => chunks.push(chunk))

    await handle.exited

    const buffer = chunks.join('')
    const token = extractClaudeToken(buffer)
    expect(token).not.toBeNull()
    expect(token).toMatch(/^sk-ant-oat01-/)
  })

  test('respeita makeHomeImpl (HOME persistente do ambiente do wizard, não um mkdtemp novo)', async () => {
    const persistentHome = await fs.mkdtemp('/tmp/gitorch-fake-engines-persistent-')
    cleanupDirs.push(persistentHome)

    const handle = fakeRunDeviceLogin({
      image: 'unused',
      binary: 'codex',
      args: [],
      makeHomeImpl: () => persistentHome,
    })
    expect(handle.hostHome).toBe(persistentHome)
    await handle.exited

    const primaryPath = ENGINE_CREDENTIAL_PATHS['codex']?.[0] as string
    const written = await fs.readFile(`${persistentHome}/${primaryPath}`, 'utf8')
    expect(JSON.parse(written)).toMatchObject({ fake: true, runtime: 'codex' })
  })

  test('writeStdin/kill nunca lançam (contrato do DeviceLoginHandle real)', async () => {
    const handle = fakeRunDeviceLogin({ image: 'unused', binary: 'codex', args: [] })
    cleanupDirs.push(handle.hostHome)
    expect(() => handle.writeStdin('qualquer coisa')).not.toThrow()
    expect(() => handle.kill()).not.toThrow()
    await handle.exited
  })
})

// Integração: os DOIS injetáveis (runDeviceLoginImpl + livenessDeps) juntos,
// exatamente como plugins/index.ts os conecta sob GITORCH_FAKE_ENGINES=1 —
// prova que o CONTRATO inteiro (login -> captureFromHome -> liveness fake ->
// 'connected' com modelos/quota) fecha ANTES do E2E de navegador (mais caro)
// tentar a mesma coisa pela UI.
describe('AssistedLoginService + EngineConnectionService com os fakes ligados (contrato de boot real)', () => {
  const originalKey = process.env['GITORCH_CREDENTIAL_KEY']
  beforeEach(() => {
    process.env['GITORCH_CREDENTIAL_KEY'] = randomBytes(32).toString('hex')
  })
  afterEach(() => {
    if (originalKey === undefined) delete process.env['GITORCH_CREDENTIAL_KEY']
    else process.env['GITORCH_CREDENTIAL_KEY'] = originalKey
  })

  function buildService() {
    const prisma = fakePrisma()
    const engineConnections = new EngineConnectionService(prisma as any, (runtime, homeDir) =>
      checkLiveness(runtime, homeDir, FAKE_LIVENESS_DEPS)
    )
    const assistedLogin = new AssistedLoginService(engineConnections, {
      image: 'unused',
      runDeviceLoginImpl: fakeRunDeviceLogin,
    })
    return { assistedLogin }
  }

  function waitForTerminal(
    assistedLogin: AssistedLoginService,
    loginId: string,
    userId: string
  ): Promise<LoginState> {
    return new Promise((resolve) => {
      const unsubscribe = assistedLogin.subscribe(loginId, userId, (state) => {
        if (state.phase === 'connected' || state.phase === 'error') {
          unsubscribe?.()
          resolve(state)
        }
      })
    })
  }

  test.each(['codex', 'antigravity'] as const)(
    '%s: login instantâneo termina "connected" com os modelos/quota fakes (sem podman, sem CLI real)',
    async (runtime) => {
      const { assistedLogin } = buildService()
      const loginId = assistedLogin.start('user-1', runtime)
      const state = await waitForTerminal(assistedLogin, loginId, 'user-1')
      expect(state.phase, JSON.stringify(state)).toBe('connected')
      if (state.phase === 'connected') {
        expect(Array.isArray(state.models) ? state.models.length : state.models).toBe(
          FAKE_MODELS.length
        )
        expect(state.quota).toBe(FAKE_QUOTA.remaining)
      }
    }
  )

  test('claude: login instantâneo via captura de token no stdout termina "connected"', async () => {
    const { assistedLogin } = buildService()
    const loginId = assistedLogin.start('user-1', 'claude')
    const state = await waitForTerminal(assistedLogin, loginId, 'user-1')
    expect(state.phase, JSON.stringify(state)).toBe('connected')
    if (state.phase === 'connected') {
      expect(state.quota).toBe(FAKE_QUOTA.remaining)
    }
  })
})
