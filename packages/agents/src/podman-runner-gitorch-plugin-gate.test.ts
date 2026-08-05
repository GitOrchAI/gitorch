import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createPodmanCommandRunner,
  resetGitorchPluginPresenceCache,
  GITORCH_PLUGIN_MARKER_PATH,
  GITORCH_PLUGIN_MISSING_MESSAGE,
  GITORCH_PLUGIN_DISABLED_MESSAGE,
} from './podman-runner.js'
import type { RuntimeCommandRequest } from './runtime-adapter.js'

// Decisão do dono: --dangerously-skip-permissions fica fixa no código
// (scheduler.ts), e JUNTO entra esta trava — nenhuma missão em container
// pode rodar sem confirmar que o plugin de segurança do GitOrch (hooks de
// gate de shell/rede/instalador) está de pé na imagem. Estes testes provam
// os 3 caminhos exigidos: plugin presente → executa; ausente → recusa;
// GITORCH_AGY_PLUGIN=0 → recusa pelo mesmo motivo. Mais um caso de cache
// (não pode custar um container extra por missão).

function buildRequest(overrides: Partial<RuntimeCommandRequest> = {}): RuntimeCommandRequest {
  return {
    binary: 'agy',
    args: ['--print', '--sandbox', 'prompt'],
    env: {},
    ...overrides,
  }
}

function ok() {
  return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 }
}

function fail(exitCode = 1) {
  return { exitCode, stdout: '', stderr: 'not found', durationMs: 1 }
}

describe('createPodmanCommandRunner com requireGitorchPlugin', () => {
  const originalPluginEnv = process.env['GITORCH_AGY_PLUGIN']

  beforeEach(() => {
    resetGitorchPluginPresenceCache()
    delete process.env['GITORCH_AGY_PLUGIN']
  })

  afterEach(() => {
    resetGitorchPluginPresenceCache()
    if (originalPluginEnv === undefined) {
      delete process.env['GITORCH_AGY_PLUGIN']
    } else {
      process.env['GITORCH_AGY_PLUGIN'] = originalPluginEnv
    }
  })

  test('sem requireGitorchPlugin (default), nunca verifica — comportamento de sempre', async () => {
    const hostRunner = vi.fn().mockResolvedValue(ok())
    const runner = createPodmanCommandRunner({ image: 'img-default', hostRunner })

    const result = await runner(buildRequest())

    expect(result.exitCode).toBe(0)
    expect(hostRunner).toHaveBeenCalledTimes(1)
  })

  test('plugin presente na imagem: verifica e executa a missão normalmente', async () => {
    const hostRunner = vi.fn().mockResolvedValue(ok())
    const runner = createPodmanCommandRunner({
      image: 'img-present',
      hostRunner,
      requireGitorchPlugin: true,
    })

    const result = await runner(buildRequest())

    expect(result.exitCode).toBe(0)
    expect(hostRunner).toHaveBeenCalledTimes(2)

    const checkCall = hostRunner.mock.calls[0][0]
    expect(checkCall.binary).toBe('podman')
    expect(checkCall.args).toEqual([
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      'img-present',
      '-c',
      `test -f ${GITORCH_PLUGIN_MARKER_PATH}`,
    ])

    const missionCall = hostRunner.mock.calls[1][0]
    expect(missionCall.args).toContain('img-present')
    expect(missionCall.args).toContain('agy')
  })

  test('plugin ausente na imagem: recusa com mensagem clara e NUNCA roda a missão', async () => {
    const hostRunner = vi.fn().mockResolvedValue(fail())
    const runner = createPodmanCommandRunner({
      image: 'img-missing',
      hostRunner,
      requireGitorchPlugin: true,
    })

    const result = await runner(buildRequest())

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toBe(GITORCH_PLUGIN_MISSING_MESSAGE)
    // Só a chamada de verificação — a missão em si nunca chegou a rodar.
    expect(hostRunner).toHaveBeenCalledTimes(1)
  })

  test('GITORCH_AGY_PLUGIN=0 (a fuga que desliga o plugin): recusa pelo mesmo motivo, sem nem gastar o container de verificação', async () => {
    process.env['GITORCH_AGY_PLUGIN'] = '0'
    const hostRunner = vi.fn().mockResolvedValue(ok())
    const runner = createPodmanCommandRunner({
      image: 'img-plugin-disabled',
      hostRunner,
      requireGitorchPlugin: true,
    })

    const result = await runner(buildRequest())

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toBe(GITORCH_PLUGIN_DISABLED_MESSAGE)
    // Recusa antes de qualquer chamada ao host — nem a verificação roda.
    expect(hostRunner).not.toHaveBeenCalled()
  })

  test('cache por processo: a verificação sobe container só na PRIMEIRA missão da mesma imagem', async () => {
    const hostRunner = vi.fn().mockResolvedValue(ok())
    const runner = createPodmanCommandRunner({
      image: 'img-cached',
      hostRunner,
      requireGitorchPlugin: true,
    })

    await runner(buildRequest())
    await runner(buildRequest())
    await runner(buildRequest())

    // 1 verificação + 3 missões = 4 — nunca 1 verificação por missão (6).
    expect(hostRunner).toHaveBeenCalledTimes(4)
    const checkCalls = hostRunner.mock.calls.filter(
      (call) => Array.isArray(call[0].args) && call[0].args.includes('--entrypoint')
    )
    expect(checkCalls).toHaveLength(1)
  })
})
