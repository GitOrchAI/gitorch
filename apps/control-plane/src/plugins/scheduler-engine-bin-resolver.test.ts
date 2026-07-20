import { afterEach, describe, expect, test, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveEngineBinDir } from './scheduler.js'

// Fábrica do registro mínimo que ClientEnvironmentService.current devolve —
// só o que resolveEngineBinDir de fato lê (path + resourcesLock).
function fakeEnvRecord(overrides: { path: string; resourcesLock: unknown }) {
  return {
    id: 'env_1',
    userId: 'user_1',
    status: 'ready',
    fixedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    lastActivityAt: new Date(),
    ...overrides,
  }
}

describe('resolveEngineBinDir (W1.3.1 — motor versionado do ambiente do cliente)', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    for (const dir of tmpDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('ambiente com resourcesLock e bin do motor em disco: devolve o dir versionado', async () => {
    const envPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-resolver-ok-'))
    tmpDirs.push(envPath)
    const binDir = path.join(envPath, '.gitorch', 'engines', 'codex', 'bin')
    await fs.mkdir(binDir, { recursive: true })
    const environments = {
      current: vi.fn(async () => fakeEnvRecord({ path: envPath, resourcesLock: { x: 1 } })),
    }

    const result = await resolveEngineBinDir('user_1', 'codex', environments)

    expect(result).toEqual({ dir: binDir })
  })

  test('sem ambiente para o usuário: fallback com motivo', async () => {
    const environments = { current: vi.fn(async () => null) }

    const result = await resolveEngineBinDir('user_sem_env', 'codex', environments)

    expect(result.dir).toBeUndefined()
    expect(result.fallbackReason).toMatch(/ambiente/i)
  })

  test('ambiente sem resourcesLock: fallback com motivo (bootstrap não rodou/falhou)', async () => {
    const envPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-resolver-no-lock-'))
    tmpDirs.push(envPath)
    const environments = {
      current: vi.fn(async () => fakeEnvRecord({ path: envPath, resourcesLock: null })),
    }

    const result = await resolveEngineBinDir('user_1', 'codex', environments)

    expect(result.dir).toBeUndefined()
    expect(result.fallbackReason).toMatch(/resourcesLock/)
  })

  test('resourcesLock presente mas bin do motor não existe em disco: fallback com motivo', async () => {
    const envPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-resolver-no-bin-'))
    tmpDirs.push(envPath)
    const environments = {
      current: vi.fn(async () => fakeEnvRecord({ path: envPath, resourcesLock: { x: 1 } })),
    }

    const result = await resolveEngineBinDir('user_1', 'antigravity', environments)

    expect(result.dir).toBeUndefined()
    expect(result.fallbackReason).toContain('antigravity')
  })

  test('bin existe mas é um arquivo, não diretório: fallback (defesa contra instalação corrompida)', async () => {
    const envPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-resolver-file-not-dir-'))
    tmpDirs.push(envPath)
    const enginesDir = path.join(envPath, '.gitorch', 'engines', 'claude')
    await fs.mkdir(enginesDir, { recursive: true })
    await fs.writeFile(path.join(enginesDir, 'bin'), 'not a dir')
    const environments = {
      current: vi.fn(async () => fakeEnvRecord({ path: envPath, resourcesLock: { x: 1 } })),
    }

    const result = await resolveEngineBinDir('user_1', 'claude', environments)

    expect(result.dir).toBeUndefined()
  })
})
