import { afterEach, describe, expect, test, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { checkLiveness, type CheckLivenessDeps, type LivenessRunner } from './engine-liveness.js'
import type { ModelDiscoverer } from './model-catalog.js'
import type { QuotaReader } from './quota-reader.js'

// Runner fake que sempre "vive" (exit 0). Sem discoverers/quotaReaders reais o
// checkLiveness cairia nos comandos de verdade (agy/codex) durante o teste — por
// isso todo caso alive:true injeta coletas fakes ou vazias.
const okRunner: LivenessRunner = async () => 'ok'
const emptyCollectors: Pick<CheckLivenessDeps, 'discoverers' | 'quotaReaders'> = {
  discoverers: {},
  quotaReaders: {},
}

afterEach(() => {
  delete process.env['GITORCH_AGY_BIN']
  delete process.env['GITORCH_CODEX_BIN']
  delete process.env['GITORCH_CLAUDE_BIN']
})

describe('checkLiveness', () => {
  test('runner exit 0 → alive com models e quota (best-effort populados)', async () => {
    const discoverers: Record<string, ModelDiscoverer> = {
      claude: async () => ['claude-opus-4-8', 'claude-sonnet-5'],
    }
    const quotaReaders: Record<string, QuotaReader> = {
      claude: async () => ({ remaining: 4000, total: 10000 }),
    }
    const res = await checkLiveness('claude', '/home/fake', {
      runner: okRunner,
      discoverers,
      quotaReaders,
    })
    expect(res.alive).toBe(true)
    expect(res.error).toBeUndefined()
    expect(res.models).toEqual(['claude-opus-4-8', 'claude-sonnet-5'])
    expect(res.quota).toEqual({ remaining: 4000, total: 10000 })
  })

  test('runner lança (binário ausente) → não-vivo, com error e coletas vazias', async () => {
    const runner: LivenessRunner = async () => {
      const e = new Error('spawn codex ENOENT') as Error & { code?: string }
      e.code = 'ENOENT'
      throw e
    }
    const res = await checkLiveness('codex', '/home/fake', { runner })
    expect(res.alive).toBe(false)
    expect(res.error ?? '').toContain('não encontrado')
    expect(res.models).toEqual([])
    expect(res.quota).toEqual({ remaining: null, total: null })
  })

  test('timeout do runner → não-vivo com mensagem de timeout (sem coletar nada)', async () => {
    const collect = vi.fn(async () => ['nunca'] as string[])
    const runner: LivenessRunner = async () => {
      const e = new Error('Command failed') as Error & { killed?: boolean; signal?: string }
      e.killed = true
      e.signal = 'SIGTERM'
      throw e
    }
    const res = await checkLiveness('claude', '/home/fake', {
      runner,
      discoverers: { claude: collect },
      quotaReaders: {},
    })
    expect(res.alive).toBe(false)
    expect(res.error ?? '').toContain('timeout')
    expect(collect).not.toHaveBeenCalled()
  })

  test('runtime desconhecido → não-vivo, sem nem chamar o runner', async () => {
    const runner = vi.fn(okRunner)
    const res = await checkLiveness('gemini-cli', '/home/fake', { runner, ...emptyCollectors })
    expect(res.alive).toBe(false)
    expect(res.error ?? '').toContain('gemini-cli')
    expect(res.models).toEqual([])
    expect(res.quota).toEqual({ remaining: null, total: null })
    expect(runner).not.toHaveBeenCalled()
  })

  test('falha em models/quota NÃO derruba alive (best-effort)', async () => {
    const discoverers: Record<string, ModelDiscoverer> = {
      claude: async () => {
        throw new Error('descoberta falhou')
      },
    }
    const quotaReaders: Record<string, QuotaReader> = {
      claude: async () => {
        throw new Error('quota falhou')
      },
    }
    const res = await checkLiveness('claude', '/home/fake', {
      runner: okRunner,
      discoverers,
      quotaReaders,
    })
    expect(res.alive).toBe(true)
    expect(res.models).toEqual([])
    expect(res.quota).toEqual({ remaining: null, total: null })
  })

  // Achado 21/07: o dono viu "conectado, 0 modelos, 0 quota" sem NENHUMA
  // pista do porquê — os catches antigos engoliam o erro em silêncio.
  test('falha em models/quota loga a causa real (nunca mais silêncio)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const discoverers: Record<string, ModelDiscoverer> = {
      claude: async () => {
        throw new Error('descoberta falhou')
      },
    }
    const quotaReaders: Record<string, QuotaReader> = {
      claude: async () => {
        throw new Error('quota falhou')
      },
    }
    await checkLiveness('claude', '/home/fake', { runner: okRunner, discoverers, quotaReaders })

    expect(warnSpy).toHaveBeenCalledWith(
      '[engine-liveness] descoberta de modelos falhou — 0 modelos',
      expect.objectContaining({ runtime: 'claude', error: 'descoberta falhou' })
    )
    expect(warnSpy).toHaveBeenCalledWith(
      '[engine-liveness] leitura de quota falhou — quota nula',
      expect.objectContaining({ runtime: 'claude', error: 'quota falhou' })
    )
    warnSpy.mockRestore()
  })

  test('usa o comando de liveness honesto de cada motor', async () => {
    const runner = vi.fn(okRunner)
    await checkLiveness('antigravity', '/h', { runner, ...emptyCollectors })
    await checkLiveness('codex', '/h', { runner, ...emptyCollectors })
    await checkLiveness('claude', '/h', { runner, ...emptyCollectors })
    expect(runner).toHaveBeenNthCalledWith(1, 'agy', ['models'], expect.anything())
    expect(runner).toHaveBeenNthCalledWith(2, 'codex', ['login', 'status'], expect.anything())
    // Anti-fachada: claude usa `auth status` (prova login), nunca `doctor`.
    expect(runner).toHaveBeenNthCalledWith(3, 'claude', ['auth', 'status'], expect.anything())
  })

  test('respeita override GITORCH_CLAUDE_BIN', async () => {
    process.env['GITORCH_CLAUDE_BIN'] = '/custom/claude'
    const runner = vi.fn(okRunner)
    await checkLiveness('claude', '/h', { runner, ...emptyCollectors })
    expect(runner).toHaveBeenCalledWith('/custom/claude', ['auth', 'status'], expect.anything())
  })

  test('injeta <homeDir>/.gitorch/env/* como env do runner (CLAUDE_CODE_OAUTH_TOKEN)', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-liveness-'))
    await fs.mkdir(path.join(home, '.gitorch', 'env'), { recursive: true })
    // Valor com \n final para provar que o runner recebe já trimado.
    await fs.writeFile(
      path.join(home, '.gitorch', 'env', 'CLAUDE_CODE_OAUTH_TOKEN'),
      'sk-oauth-fake-token\n'
    )

    let capturedEnv: NodeJS.ProcessEnv | undefined
    const runner: LivenessRunner = async (_bin, _args, env) => {
      capturedEnv = env
      return 'ok'
    }
    const res = await checkLiveness('claude', home, { runner, ...emptyCollectors })

    expect(res.alive).toBe(true)
    expect(capturedEnv?.['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-oauth-fake-token')
    expect(capturedEnv?.['HOME']).toBe(home)
    await fs.rm(home, { recursive: true, force: true })
  })

  test('error de execução redige segredos do stderr (sem vazar credencial)', async () => {
    const secret = 'sk-supersecretvalue012345678901234'
    const runner: LivenessRunner = async () => {
      const e = new Error('boom') as Error & { code?: number; stderr?: string }
      e.code = 1
      e.stderr = `auth failed CLAUDE_CODE_OAUTH_TOKEN=${secret}`
      throw e
    }
    const res = await checkLiveness('claude', '/home/fake', { runner })
    expect(res.alive).toBe(false)
    expect(res.error ?? '').not.toContain(secret)
    expect(res.error ?? '').toContain('***')
  })
})
