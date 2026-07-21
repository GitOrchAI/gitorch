import { describe, it, expect, vi, afterEach } from 'vitest'
import { runAgyChatCommand, AGY_CHAT_PTY_COLS, AGY_CHAT_PTY_ROWS } from './agy-chat-runner.js'

function fakeIPty() {
  return {
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
    pid: 123,
  }
}

afterEach(() => {
  delete process.env['XDG_RUNTIME_DIR']
})

describe('runAgyChatCommand', () => {
  it('sobe o `agy` (sem args) direto no host — nunca via podman', () => {
    const pty = fakeIPty()
    const ptySpawnImpl = vi.fn(() => pty) as unknown as (
      file: string,
      args: string[],
      options: Record<string, unknown>
    ) => typeof pty
    runAgyChatCommand({ homeDir: '/home/x', ptySpawnImpl })

    expect(ptySpawnImpl).toHaveBeenCalledTimes(1)
    const [file, args] = ptySpawnImpl.mock.calls[0]!
    expect(file).toBe('agy')
    expect(args).toEqual([]) // modo chat — nunca 'usage' (não é comando de quota)
  })

  it('usa o binário sobrescrito por `agyBin` quando fornecido', () => {
    const pty = fakeIPty()
    const ptySpawnImpl = vi.fn(() => pty) as unknown as (
      file: string,
      args: string[],
      options: Record<string, unknown>
    ) => typeof pty
    runAgyChatCommand({ homeDir: '/home/x', agyBin: '/opt/custom/agy', ptySpawnImpl })
    const [file] = ptySpawnImpl.mock.calls[0]!
    expect(file).toBe('/opt/custom/agy')
  })

  it('HOME do processo é o homeDir recebido (credencial já materializada ali)', () => {
    const pty = fakeIPty()
    const ptySpawnImpl = vi.fn(() => pty) as unknown as (
      file: string,
      args: string[],
      options: Record<string, unknown>
    ) => typeof pty
    runAgyChatCommand({ homeDir: '/home/cliente-x', ptySpawnImpl })
    const [, , options] = ptySpawnImpl.mock.calls[0]!
    expect((options as { env?: Record<string, string> }).env?.['HOME']).toBe('/home/cliente-x')
  })

  it('repassa XDG_RUNTIME_DIR quando presente no ambiente (Antigravity trava sem ele)', () => {
    process.env['XDG_RUNTIME_DIR'] = '/run/user/1001'
    const pty = fakeIPty()
    const ptySpawnImpl = vi.fn(() => pty) as unknown as (
      file: string,
      args: string[],
      options: Record<string, unknown>
    ) => typeof pty
    runAgyChatCommand({ homeDir: '/home/x', ptySpawnImpl })
    const [, , options] = ptySpawnImpl.mock.calls[0]!
    expect((options as { env?: Record<string, string> }).env?.['XDG_RUNTIME_DIR']).toBe(
      '/run/user/1001'
    )
  })

  it('não seta XDG_RUNTIME_DIR quando ausente do ambiente', () => {
    const pty = fakeIPty()
    const ptySpawnImpl = vi.fn(() => pty) as unknown as (
      file: string,
      args: string[],
      options: Record<string, unknown>
    ) => typeof pty
    runAgyChatCommand({ homeDir: '/home/x', ptySpawnImpl })
    const [, , options] = ptySpawnImpl.mock.calls[0]!
    expect((options as { env?: Record<string, string> }).env?.['XDG_RUNTIME_DIR']).toBeUndefined()
  })

  it('terminal largo o bastante pra a tela do /usage nunca quebrar (default)', () => {
    const pty = fakeIPty()
    const ptySpawnImpl = vi.fn(() => pty) as unknown as (
      file: string,
      args: string[],
      options: Record<string, unknown>
    ) => typeof pty
    runAgyChatCommand({ homeDir: '/home/x', ptySpawnImpl })
    const [, , options] = ptySpawnImpl.mock.calls[0]!
    expect((options as { cols?: number; rows?: number }).cols).toBe(AGY_CHAT_PTY_COLS)
    expect((options as { cols?: number; rows?: number }).rows).toBe(AGY_CHAT_PTY_ROWS)
  })

  it('aceita cols/rows customizados', () => {
    const pty = fakeIPty()
    const ptySpawnImpl = vi.fn(() => pty) as unknown as (
      file: string,
      args: string[],
      options: Record<string, unknown>
    ) => typeof pty
    runAgyChatCommand({ homeDir: '/home/x', cols: 80, rows: 24, ptySpawnImpl })
    const [, , options] = ptySpawnImpl.mock.calls[0]!
    expect((options as { cols?: number }).cols).toBe(80)
    expect((options as { rows?: number }).rows).toBe(24)
  })

  it('onStdout/writeStdin/kill/exited funcionam (reusa wirePtyHandle)', async () => {
    const pty = {
      onData: vi.fn((cb: (data: string) => void) => {
        setTimeout(() => cb('bem-vindo ao agy\n'), 0)
      }),
      onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => {
        setTimeout(() => cb({ exitCode: 0 }), 0)
      }),
      write: vi.fn(),
      kill: vi.fn(),
      pid: 123,
    }
    const ptySpawnImpl = vi.fn(() => pty) as unknown as (
      file: string,
      args: string[],
      options: Record<string, unknown>
    ) => typeof pty
    const handle = runAgyChatCommand({ homeDir: '/home/x', ptySpawnImpl })
    const seen: string[] = []
    handle.onStdout((c) => seen.push(c))
    handle.writeStdin('/usage')
    handle.kill()

    const res = await handle.exited
    expect(seen.join('')).toContain('bem-vindo ao agy')
    expect(pty.write).toHaveBeenCalledWith('/usage')
    expect(pty.kill).toHaveBeenCalledWith('SIGTERM')
    expect(res.code).toBe(0)
  })
})
