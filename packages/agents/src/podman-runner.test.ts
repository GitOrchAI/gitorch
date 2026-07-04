import { describe, expect, test, vi } from 'vitest'
import { createPodmanCommandRunner } from './podman-runner.js'
import type { RuntimeCommandRequest } from './runtime-adapter.js'

function buildRequest(overrides: Partial<RuntimeCommandRequest> = {}): RuntimeCommandRequest {
  return {
    binary: 'agy',
    args: ['--print', '--sandbox', '--add-dir', '/var/lib/ws/u/p', 'prompt'],
    env: { GITORCH_RUNTIME: 'antigravity' },
    cwd: '/var/lib/ws/u/p',
    timeoutMs: 1000,
    ...overrides,
  }
}

function ok() {
  return { exitCode: 0, stdout: '', stderr: '', durationMs: 1 }
}

describe('createPodmanCommandRunner', () => {
  test('monta o workspace e executa o binário dentro do container', async () => {
    const hostRunner = vi.fn().mockResolvedValue(ok())
    const runner = createPodmanCommandRunner({ image: 'localhost/img:1', hostRunner })

    await runner(buildRequest())

    const call = hostRunner.mock.calls[0][0]
    expect(call.binary).toBe('podman')
    expect(call.args).toContain('run')
    expect(call.args).toContain('--rm')
    expect(call.args).toContain('--userns=keep-id')
    expect(call.args).toContain('/var/lib/ws/u/p:/workspace:rw')
    expect(call.args).toContain('localhost/img:1')
    expect(call.timeoutMs).toBe(1000)
    // HOME fica fora do workspace
    expect(call.args).toContain('HOME=/home/agent')
  })

  test('traduz o caminho do host (exato e subcaminho) para /workspace', async () => {
    const hostRunner = vi.fn().mockResolvedValue(ok())
    const runner = createPodmanCommandRunner({ image: 'img', hostRunner })

    await runner(
      buildRequest({ args: ['--add-dir', '/var/lib/ws/u/p', '--extra', '/var/lib/ws/u/p/docs'] })
    )

    const args: string[] = hostRunner.mock.calls[0][0].args
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/workspace')
    expect(args[args.indexOf('--extra') + 1]).toBe('/workspace/docs')
    const afterImage = args.slice(args.indexOf('img') + 1)
    expect(afterImage).not.toContain('/var/lib/ws/u/p')
  })

  test('passa apenas o ambiente explícito da missão para dentro do container', async () => {
    const hostRunner = vi.fn().mockResolvedValue(ok())
    const runner = createPodmanCommandRunner({ image: 'img', hostRunner })

    await runner(
      buildRequest({ env: { GITORCH_RUNTIME: 'antigravity', GITORCH_RUNTIME_MODEL: 'm1' } })
    )

    const args: string[] = hostRunner.mock.calls[0][0].args
    expect(args).toContain('GITORCH_RUNTIME=antigravity')
    expect(args).toContain('GITORCH_RUNTIME_MODEL=m1')
    expect(hostRunner.mock.calls[0][0].env).toEqual({})
  })

  test('montagens são somente-leitura por padrão (credenciais nunca graváveis)', async () => {
    const hostRunner = vi.fn().mockResolvedValue(ok())
    const runner = createPodmanCommandRunner({
      image: 'img',
      hostRunner,
      mounts: [
        { source: '/home/x/.gemini', target: '/home/agent/.gemini' },
        { source: '/tmp/cache', target: '/home/agent/cache', readOnly: false },
      ],
    })

    await runner(buildRequest())

    const args: string[] = hostRunner.mock.calls[0][0].args
    expect(args).toContain('/home/x/.gemini:/home/agent/.gemini:ro')
    expect(args).toContain('/tmp/cache:/home/agent/cache:rw')
  })

  test('remove o container à força quando o timeout mata o cliente podman', async () => {
    const hostRunner = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 124, stdout: '', stderr: 'timeout', durationMs: 5 })
      .mockResolvedValueOnce(ok())
    const runner = createPodmanCommandRunner({ image: 'img', hostRunner })

    const result = await runner(buildRequest())

    expect(result.exitCode).toBe(124)
    const cleanup = hostRunner.mock.calls[1][0]
    expect(cleanup.args[0]).toBe('rm')
    expect(cleanup.args[1]).toBe('-f')
    expect(String(cleanup.args[2])).toContain('gitorch-mission-')
  })

  test('não tenta remover container quando a missão termina normalmente', async () => {
    const hostRunner = vi.fn().mockResolvedValue(ok())
    const runner = createPodmanCommandRunner({ image: 'img', hostRunner })

    await runner(buildRequest())

    expect(hostRunner).toHaveBeenCalledTimes(1)
  })

  test('prepareMounts injeta montagens por missão e chama cleanup ao fim', async () => {
    const hostRunner = vi.fn().mockResolvedValue(ok())
    const cleanup = vi.fn().mockResolvedValue(undefined)
    const prepareMounts = vi.fn().mockResolvedValue({
      mounts: [{ source: '/tmp/mission-cred-abc', target: '/run/gitorch-credentials' }],
      cleanup,
    })
    const runner = createPodmanCommandRunner({ image: 'img', hostRunner, prepareMounts })

    await runner(buildRequest())

    const args: string[] = hostRunner.mock.calls[0][0].args
    expect(args).toContain('/tmp/mission-cred-abc:/run/gitorch-credentials:ro')
    expect(prepareMounts).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  test('cleanup roda mesmo quando a execução falha', async () => {
    const hostRunner = vi.fn().mockRejectedValue(new Error('boom'))
    const cleanup = vi.fn().mockResolvedValue(undefined)
    const runner = createPodmanCommandRunner({
      image: 'img',
      hostRunner,
      prepareMounts: vi.fn().mockResolvedValue({ mounts: [], cleanup }),
    })

    await expect(runner(buildRequest())).rejects.toThrow('boom')
    expect(cleanup).toHaveBeenCalledOnce()
  })
})
