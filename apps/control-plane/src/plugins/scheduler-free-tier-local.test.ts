import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  CreatePodmanCommandRunnerOptions,
  RuntimeCommandRunner,
  RuntimeCommandResult,
} from '@gitorch/agents'
import {
  buildMissionRunner,
  buildRemoteRuntimeStackIfConfigured,
  selectRuntimeStack,
  type RuntimeStack,
} from './scheduler.js'

// Mesmo seam de scheduler-mission-cpus.test.ts: captura as options que
// chegariam no createPodmanCommandRunner sem subir podman de verdade — aqui
// é o que prova que o stack local (o mesmo que o free tier usa em produção,
// sem as envs GITORCH_FREE_TIER_*) carrega o trio completo de tetos.
const capturedOptions: CreatePodmanCommandRunnerOptions[] = []

vi.mock('@gitorch/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gitorch/agents')>()
  return {
    ...actual,
    createPodmanCommandRunner: (
      options: CreatePodmanCommandRunnerOptions
    ): RuntimeCommandRunner => {
      capturedOptions.push(options)
      return async (): Promise<RuntimeCommandResult> => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 0,
      })
    },
  }
})

const ENV_KEYS = [
  'GITORCH_EXECUTOR',
  'GITORCH_MISSION_CRED_DIR',
  'GITORCH_MISSION_MEMORY',
  'GITORCH_MISSION_MEMORY_SWAP',
  'GITORCH_MISSION_CPUS',
  'GITORCH_FREE_TIER_SSH_HOST',
  'GITORCH_FREE_TIER_SSH_KEY',
  'GITORCH_FREE_TIER_AGENT_IMAGE',
  'GITORCH_FREE_TIER_CONTAINER_ENGINE',
  'GITORCH_FREE_TIER_REMOTE_BASE_DIR',
]

// App fake: só o que os builders realmente usam na CONSTRUÇÃO do runner
// (log). Nenhuma missão é de fato executada.
const fakeApp = {
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
} as never
const fakeEnvironments = { current: async () => null } as never

describe('F2.1.5: free tier roda LOCAL em produção com os MESMOS tetos das pagas (P2-6)', () => {
  const original: Record<string, string | undefined> = {}

  beforeEach(() => {
    capturedOptions.length = 0
    for (const key of ENV_KEYS) {
      original[key] = process.env[key]
      delete process.env[key]
    }
    process.env['GITORCH_MISSION_CRED_DIR'] = path.join(
      os.tmpdir(),
      `gitorch-test-cred-${randomUUID()}`
    )
    process.env['GITORCH_EXECUTOR'] = 'podman'
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
  })

  test('produção (sem GITORCH_FREE_TIER_*): stack remoto não existe e o free tier cai pro MESMO stack local das pagas', () => {
    expect(buildRemoteRuntimeStackIfConfigured(fakeApp)).toBeNull()

    const local = { tag: 'local' } as unknown as RuntimeStack
    // free e pago decidem para o MESMO objeto local — não existe um segundo
    // caminho "grátis" hollow que pudesse perder um teto por conta própria.
    expect(selectRuntimeStack('free', local, buildRemoteRuntimeStackIfConfigured(fakeApp))).toBe(
      local
    )
    expect(selectRuntimeStack('pro', local, buildRemoteRuntimeStackIfConfigured(fakeApp))).toBe(
      local
    )
  })

  test('o stack local que o free tier usa em produção carrega os MESMOS tetos de memória/swap/CPU das pagas', () => {
    buildMissionRunner(fakeApp, fakeEnvironments)
    expect(capturedOptions).toHaveLength(1)
    expect(capturedOptions[0]?.memoryLimit).toBe('2g')
    expect(capturedOptions[0]?.memorySwapLimit).toBe('2g')
    expect(capturedOptions[0]?.cpus).toBe('1.5')
  })
})
