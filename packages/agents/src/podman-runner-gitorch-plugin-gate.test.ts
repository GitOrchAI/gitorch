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

  // Achado importante: stack local e stack remoto do free-tier podem ter o
  // MESMO engine+imagem por default — sem `runnerId` na chave do cache, a
  // missão do segundo runner reusava o resultado verificado no PRIMEIRO,
  // sem nunca checar o host dela de verdade.
  test('runnerId distintos (mesma imagem/engine) NÃO compartilham cache — cada runner é verificado de verdade', async () => {
    const hostRunnerLocal = vi.fn().mockResolvedValue(ok())
    const hostRunnerRemoto = vi.fn().mockResolvedValue(fail())

    const runnerLocal = createPodmanCommandRunner({
      image: 'img-mesma-tag',
      podmanBinary: 'podman',
      hostRunner: hostRunnerLocal,
      requireGitorchPlugin: true,
      runnerId: 'local',
    })
    const runnerRemoto = createPodmanCommandRunner({
      image: 'img-mesma-tag',
      podmanBinary: 'podman',
      hostRunner: hostRunnerRemoto,
      requireGitorchPlugin: true,
      runnerId: 'ssh:free-tier-host',
    })

    const resultLocal = await runnerLocal(buildRequest())
    const resultRemoto = await runnerRemoto(buildRequest())

    // O local tem o plugin (ok()) e roda a missão.
    expect(resultLocal.exitCode).toBe(0)
    expect(hostRunnerLocal).toHaveBeenCalledTimes(2) // verificação + missão

    // O remoto NÃO tem o plugin (fail()) e é recusado — a checagem dele
    // rodou de verdade, não herdou o resultado positivo do local.
    expect(resultRemoto.exitCode).not.toBe(0)
    expect(resultRemoto.stderr).toBe(GITORCH_PLUGIN_MISSING_MESSAGE)
    expect(hostRunnerRemoto).toHaveBeenCalledTimes(1) // só a verificação, nunca a missão
  })

  // Achado importante: falha transitória (hiccup do host runner) não pode
  // virar recusa permanente — só o `true` é cacheado.
  test('resultado NEGATIVO não fica cacheado: um hiccup transitório não recusa todas as missões seguintes para sempre', async () => {
    const hostRunner = vi
      .fn()
      // 1ª verificação: hiccup (não tem o plugin desta vez / rede instável).
      .mockResolvedValueOnce(fail())
      // 2ª verificação (nova tentativa, missão seguinte): agora confirma.
      .mockResolvedValueOnce(ok())
      // Execução da missão da 2ª tentativa.
      .mockResolvedValueOnce(ok())

    const runner = createPodmanCommandRunner({
      image: 'img-hiccup',
      hostRunner,
      requireGitorchPlugin: true,
    })

    const primeira = await runner(buildRequest())
    expect(primeira.exitCode).not.toBe(0)
    expect(primeira.stderr).toBe(GITORCH_PLUGIN_MISSING_MESSAGE)

    const segunda = await runner(buildRequest())

    // A missão seguinte tentou verificar de NOVO (não confiou cegamente no
    // `false` cacheado) e, desta vez, o plugin foi confirmado — a missão roda.
    expect(segunda.exitCode).toBe(0)
    const checkCalls = hostRunner.mock.calls.filter(
      (call) => Array.isArray(call[0].args) && call[0].args.includes('--entrypoint')
    )
    expect(checkCalls).toHaveLength(2)
  })
})
