import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  CreatePodmanCommandRunnerOptions,
  RuntimeCommandRunner,
  RuntimeCommandResult,
} from '@gitorch/agents'
import { buildMissionRunner, buildRemoteRuntimeStackIfConfigured } from './scheduler.js'

// Captura as options passadas ao createPodmanCommandRunner SEM rodar o
// runner real — os dois pontos de entrada do scheduler (stack local via
// buildMissionRunner e stack remoto do free-tier via
// buildRemoteRuntimeStackIfConfigured) convergem nessa chamada, então é o
// seam mais estreito que ainda observa os dois call sites sem subir a app
// Fastify inteira nem tocar podman de verdade.
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
  'GITORCH_MISSION_CPUS',
  'GITORCH_EXECUTOR',
  'GITORCH_MISSION_CRED_DIR',
  'GITORCH_FREE_TIER_SSH_HOST',
  'GITORCH_FREE_TIER_SSH_KEY',
]

// App fake: só o que os dois builders realmente usam na CONSTRUÇÃO do
// runner (log). engineConnections só é tocado dentro do prepareMounts, que
// não é invocado aqui — nenhuma missão é de fato executada.
const fakeApp = {
  log: { info: () => undefined, warn: () => undefined, error: () => undefined },
} as never
const fakeEnvironments = { current: async () => null } as never

describe('teto de CPU alcança o podman pelos 2 pontos de entrada do scheduler (achado #3 do review)', () => {
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
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
  })

  test('buildMissionRunner (stack local, podman): sem env, o teto default 1.5 chega em options.cpus', () => {
    process.env['GITORCH_EXECUTOR'] = 'podman'
    buildMissionRunner(fakeApp, fakeEnvironments)
    expect(capturedOptions).toHaveLength(1)
    expect(capturedOptions[0]?.cpus).toBe('1.5')
  })

  // Achado #1 do review: GITORCH_MISSION_CPUS='' é presente-mas-vazia (erro
  // comum de .env/systemd/compose). Com o `??` antigo isto virava cpus:'' —
  // falsy no gate do podman-runner, então NENHUM --cpus saía e a missão
  // rodava sem teto, em silêncio. Esta asserção falha se essa regressão
  // voltar em QUALQUER um dos dois call sites.
  test('buildMissionRunner: env presente-mas-vazia NÃO desliga o teto (achado #1 do review)', () => {
    process.env['GITORCH_EXECUTOR'] = 'podman'
    process.env['GITORCH_MISSION_CPUS'] = ''
    buildMissionRunner(fakeApp, fakeEnvironments)
    expect(capturedOptions[0]?.cpus).toBe('1.5')
  })

  test('buildRemoteRuntimeStackIfConfigured (stack remoto/free-tier): sem env, o teto default 1.5 chega em options.cpus', () => {
    process.env['GITORCH_FREE_TIER_SSH_HOST'] = 'gitorch@203.0.113.10'
    process.env['GITORCH_FREE_TIER_SSH_KEY'] = '/etc/gitorch/keys/free-tier'
    buildRemoteRuntimeStackIfConfigured(fakeApp)
    expect(capturedOptions).toHaveLength(1)
    expect(capturedOptions[0]?.cpus).toBe('1.5')
  })

  test('buildRemoteRuntimeStackIfConfigured: env presente-mas-vazia NÃO desliga o teto (achado #1 do review)', () => {
    process.env['GITORCH_FREE_TIER_SSH_HOST'] = 'gitorch@203.0.113.10'
    process.env['GITORCH_FREE_TIER_SSH_KEY'] = '/etc/gitorch/keys/free-tier'
    process.env['GITORCH_MISSION_CPUS'] = '   '
    buildRemoteRuntimeStackIfConfigured(fakeApp)
    expect(capturedOptions[0]?.cpus).toBe('1.5')
  })

  test('override válido do operador chega IDÊNTICO aos 2 call sites (sem drift)', () => {
    process.env['GITORCH_MISSION_CPUS'] = '3'
    process.env['GITORCH_EXECUTOR'] = 'podman'
    buildMissionRunner(fakeApp, fakeEnvironments)

    process.env['GITORCH_FREE_TIER_SSH_HOST'] = 'gitorch@203.0.113.10'
    process.env['GITORCH_FREE_TIER_SSH_KEY'] = '/etc/gitorch/keys/free-tier'
    buildRemoteRuntimeStackIfConfigured(fakeApp)

    expect(capturedOptions).toHaveLength(2)
    expect(capturedOptions[0]?.cpus).toBe('3')
    expect(capturedOptions[1]?.cpus).toBe('3')
  })
})
