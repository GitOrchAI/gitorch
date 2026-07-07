import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { runDeviceLogin } from './device-login-runner.js'

// Fake do processo do podman: stdout/stderr como EventEmitter, stdin com write,
// kill espionável. Espelha o shape mínimo que o runner usa.
function fakeSpawn() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { write: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
  }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.stdin = { write: vi.fn() }
  proc.kill = vi.fn()
  const spawn = vi.fn(() => proc) as unknown as typeof import('node:child_process').spawn
  return { proc, spawn }
}

describe('runDeviceLogin', () => {
  it('streams stdout, exposes a host HOME, and resolves on exit', async () => {
    const { proc, spawn } = fakeSpawn()
    const handle = runDeviceLogin({
      image: 'img',
      binary: 'codex',
      args: ['login', '--device-auth'],
      spawnImpl: spawn,
      makeHomeImpl: () => '/tmp/gitorch-login-fixed/xyz',
    })
    const seen: string[] = []
    handle.onStdout((c) => seen.push(c))
    proc.stdout.emit('data', Buffer.from('Open this link\n'))
    proc.stdout.emit('data', Buffer.from('code ABCD-EFGH\n'))
    proc.emit('close', 0)
    const res = await handle.exited
    expect(seen.join('')).toContain('ABCD-EFGH')
    expect(handle.hostHome === '/tmp/gitorch-login-fixed/xyz').toBe(true)
    expect(res.code).toBe(0)
  })

  it('bind-mounts the host HOME (not tmpfs) so the written credential survives --rm', () => {
    const { spawn } = fakeSpawn()
    const handle = runDeviceLogin({
      image: 'the-image',
      binary: 'codex',
      args: ['login', '--device-auth'],
      spawnImpl: spawn,
      makeHomeImpl: () => '/tmp/gitorch-login-fixed/xyz',
    })
    const [, argv] = (spawn as unknown as { mock: { calls: [string, string[]][] } }).mock.calls[0]!
    const joined = argv.join(' ')
    expect(argv[0]).toBe('run')
    expect(joined).toContain('--rm')
    expect(joined).toContain('-i') // stdin aberto (código do Claude)
    // HOME é bind-mount do host, não tmpfs: a credencial gravada persiste.
    expect(joined).toContain(`-v ${handle.hostHome}:/home/agent:rw`)
    expect(joined).toContain('HOME=/home/agent')
    expect(joined).toContain('the-image')
    expect(joined).toContain('codex login --device-auth')
    // sem PTY por padrão
    expect(argv).not.toContain('-t')
  })

  it('allocates a TTY (-t) when usePty is set (Claude setup-token needs a PTY)', () => {
    const { spawn } = fakeSpawn()
    runDeviceLogin({
      image: 'img',
      binary: 'claude',
      args: ['setup-token'],
      usePty: true,
      spawnImpl: spawn,
      makeHomeImpl: () => '/tmp/gitorch-login-fixed/xyz',
    })
    const [, argv] = (spawn as unknown as { mock: { calls: [string, string[]][] } }).mock.calls[0]!
    expect(argv).toContain('-t')
  })

  it('writeStdin forwards to the process stdin (Claude pastes the callback code back)', () => {
    const { proc, spawn } = fakeSpawn()
    const handle = runDeviceLogin({
      image: 'img',
      binary: 'claude',
      args: ['setup-token'],
      spawnImpl: spawn,
      makeHomeImpl: () => '/tmp/gitorch-login-fixed/xyz',
    })
    handle.writeStdin('the-pasted-code\n')
    expect(proc.stdin.write).toHaveBeenCalledWith('the-pasted-code\n')
  })
})
