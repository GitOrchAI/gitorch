import { describe, expect, test, vi } from 'vitest'
import { createSshCommandRunner } from './ssh-command-runner.js'

function ok() {
  return { exitCode: 0, stdout: 'out', stderr: '', durationMs: 1 }
}

describe('createSshCommandRunner', () => {
  test('embrulha o comando em ssh com identidade e host, quotando os argumentos', async () => {
    const inner = vi.fn().mockResolvedValue(ok())
    const runner = createSshCommandRunner({
      host: 'gitorch@203.0.113.10',
      identityFile: '/keys/mtsaas',
      inner,
    })

    await runner({ binary: 'podman', args: ['run', '--rm', '-e', 'FOO=bar baz'], env: {} })

    const call = inner.mock.calls[0][0]
    expect(call.binary).toBe('ssh')
    expect(call.args).toContain('-i')
    expect(call.args).toContain('/keys/mtsaas')
    expect(call.args).toContain('gitorch@203.0.113.10')
    // Último argumento = comando remoto, com cada token quotado: arg com espaço preservado.
    const remote = call.args[call.args.length - 1]
    expect(remote).toBe("'podman' 'run' '--rm' '-e' 'FOO=bar baz'")
  })

  test('encaminha stdin e timeout ao inner; o ssh não herda env da missão', async () => {
    const inner = vi.fn().mockResolvedValue(ok())
    const runner = createSshCommandRunner({ host: 'h', identityFile: 'k', inner })

    await runner({
      binary: 'podman',
      args: ['run'],
      env: { SECRET: 'x' },
      stdin: 'prompt',
      timeoutMs: 5000,
    })

    const call = inner.mock.calls[0][0]
    expect(call.stdin).toBe('prompt')
    expect(call.timeoutMs).toBe(5000)
    // O processo ssh local roda com env vazio: nada do control plane vaza para ele.
    expect(call.env).toEqual({})
  })

  test('escapa aspas simples dentro de um argumento', async () => {
    const inner = vi.fn().mockResolvedValue(ok())
    const runner = createSshCommandRunner({ host: 'h', identityFile: 'k', inner })

    await runner({ binary: 'sh', args: ["it's"], env: {} })

    const remote = inner.mock.calls[0][0].args.at(-1)
    expect(remote).toBe("'sh' 'it'\\''s'")
  })

  test('devolve o resultado do inner', async () => {
    const inner = vi
      .fn()
      .mockResolvedValue({ exitCode: 7, stdout: 'o', stderr: 'e', durationMs: 2 })
    const runner = createSshCommandRunner({ host: 'h', identityFile: 'k', inner })

    const res = await runner({ binary: 'x', args: [], env: {} })

    expect(res.exitCode).toBe(7)
  })
})
