import { afterEach, describe, expect, test, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createLocalCredentialRunner } from './scheduler.js'

describe('createLocalCredentialRunner', () => {
  const tmpDirs: string[] = []

  afterEach(async () => {
    for (const dir of tmpDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('materializa a credencial do dono num HOME temporário e exporta .gitorch/env/* pro processo filho', async () => {
    const materializeToHome = vi.fn(async (_userId: string, _runtime: string, dir: string) => {
      tmpDirs.push(dir)
      await fs.mkdir(path.join(dir, '.gitorch', 'env'), { recursive: true })
      await fs.writeFile(
        path.join(dir, '.gitorch', 'env', 'CLAUDE_CODE_OAUTH_TOKEN'),
        'sk-fake-token\n'
      )
      return true
    })
    const inner = vi.fn(async (request: { env: Record<string, string> }) => ({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      durationMs: 1,
      capturedEnv: request.env,
    }))

    const runner = createLocalCredentialRunner({ materializeToHome }, inner as never)
    const result = (await runner({
      binary: 'claude',
      args: [],
      env: { GITORCH_RUNTIME: 'claude', GITORCH_OWNER_USER_ID: 'user_1' },
    })) as unknown as { capturedEnv: Record<string, string> }

    expect(materializeToHome).toHaveBeenCalledWith('user_1', 'claude', expect.any(String))
    expect(result.capturedEnv['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-fake-token')
    // HOME do processo filho aponta pro diretório materializado, não o do host.
    expect(result.capturedEnv['HOME']).not.toBe(os.homedir())
  })

  test('sem GITORCH_RUNTIME/GITORCH_OWNER_USER_ID, chama o runner interno sem tocar credenciais', async () => {
    const materializeToHome = vi.fn()
    const inner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }))
    const runner = createLocalCredentialRunner({ materializeToHome }, inner as never)

    await runner({ binary: 'codex', args: [], env: {} })

    expect(materializeToHome).not.toHaveBeenCalled()
    expect(inner).toHaveBeenCalledWith({ binary: 'codex', args: [], env: {} })
  })

  test('sem conexão do motor (materializeToHome retorna false), roda sem credencial ao invés de travar a missão', async () => {
    const materializeToHome = vi.fn().mockResolvedValue(false)
    const inner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 }))
    const runner = createLocalCredentialRunner({ materializeToHome }, inner as never)

    await runner({
      binary: 'codex',
      args: [],
      env: { GITORCH_RUNTIME: 'codex', GITORCH_OWNER_USER_ID: 'user_2' },
    })

    expect(inner).toHaveBeenCalledWith({
      binary: 'codex',
      args: [],
      env: { GITORCH_RUNTIME: 'codex', GITORCH_OWNER_USER_ID: 'user_2' },
    })
  })

  test('sempre limpa o diretório temporário de staging, mesmo se o runner interno falhar', async () => {
    let capturedDir = ''
    const materializeToHome = vi.fn(async (_u: string, _r: string, dir: string) => {
      capturedDir = dir
      return true
    })
    const inner = vi.fn(async () => {
      throw new Error('boom')
    })
    const runner = createLocalCredentialRunner({ materializeToHome }, inner as never)

    await expect(
      runner({
        binary: 'codex',
        args: [],
        env: { GITORCH_RUNTIME: 'codex', GITORCH_OWNER_USER_ID: 'user_3' },
      })
    ).rejects.toThrow('boom')

    await expect(fs.stat(capturedDir)).rejects.toThrow()
  })
})
