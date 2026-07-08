import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { runDeviceLogin } from './device-login-runner.js'

// Fake do processo do podman: stdout/stderr como EventEmitter, stdin com write,
// kill espionável. Espelha o shape mínimo que o runner usa.
function fakeSpawn() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
  }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.stdin = Object.assign(new EventEmitter(), { write: vi.fn() })
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

  it('quando usePty é true, chama ptySpawnImpl (não o spawnImpl de pipes) — o caminho de PTY é o único usado', () => {
    const { spawn } = fakeSpawn()
    const fakeIPty = {
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      pid: 123,
    }
    const ptySpawnImpl = vi.fn(() => fakeIPty) as unknown as (
      file: string,
      args: string[],
      options: Record<string, unknown>
    ) => typeof fakeIPty
    runDeviceLogin({
      image: 'img',
      binary: 'claude',
      args: ['setup-token'],
      usePty: true,
      spawnImpl: spawn,
      ptySpawnImpl,
      makeHomeImpl: () => '/tmp/gitorch-login-fixed/xyz',
    })
    expect(ptySpawnImpl).toHaveBeenCalledTimes(1)
    expect(spawn).not.toHaveBeenCalled()
    const [file, argv] = ptySpawnImpl.mock.calls[0]!
    expect(file).toBe('podman')
    expect(argv).toContain('-t')
    expect(argv).toContain('the-image'.replace('the-image', 'img')) // confirma que o argv chegou completo
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

  it('a spawn error resolves `exited` as a failure instead of crashing the process (unhandled "error" event)', async () => {
    const { proc, spawn } = fakeSpawn()
    const handle = runDeviceLogin({
      image: 'img',
      binary: 'codex',
      args: ['login', '--device-auth'],
      spawnImpl: spawn,
      makeHomeImpl: () => '/tmp/gitorch-login-fixed/xyz',
    })
    // Sem listener de 'error' no proc real do Node, isto derrubaria o processo
    // inteiro (EventEmitter trata 'error' sem listener como exceção não
    // tratada). Se o runner anexou o listener corretamente, isto é só um
    // evento normal e `exited` resolve (nunca rejeita) com um resultado que
    // `AssistedLoginService.onExit` trata como falha (code !== 0).
    proc.emit('error', new Error('spawn podman ENOENT'))
    const res = await handle.exited
    expect(res.code).not.toBe(0)
  })

  it('writeStdin after the stdin pipe errors (EPIPE, process already exited) does not throw or crash', async () => {
    const { proc, spawn } = fakeSpawn()
    const handle = runDeviceLogin({
      image: 'img',
      binary: 'claude',
      args: ['setup-token'],
      spawnImpl: spawn,
      makeHomeImpl: () => '/tmp/gitorch-login-fixed/xyz',
    })
    // Simula o container já ter saído (cleanup() matou o processo) enquanto um
    // submitCode() atrasado ainda tenta escrever no stdin — proc.stdin.write
    // dispara 'error' (EPIPE) no pipe torn-down. Sem listener, isso derrubaria
    // o processo inteiro; com o fix, é engolido.
    proc.stdin.emit('error', new Error('EPIPE'))
    expect(() => handle.writeStdin('too-late-code\n')).not.toThrow()
    // O processo de teste continua vivo e o exited handle não é afetado por
    // isto sozinho (sem 'close'/'error' no proc principal ainda pendente).
    proc.emit('close', 0)
    const res = await handle.exited
    expect(res.code).toBe(0)
  })

  it('usa um PTY real (node-pty) quando usePty é true, com terminal largo o bastante pra não truncar URLs longas', async () => {
    const fakeIPty = {
      // Espelha o node-pty real: onData entrega via um evento assíncrono de
      // verdade (net.Socket/libuv), nunca no mesmo tick do registro.
      onData: vi.fn((cb: (data: string) => void) => {
        setTimeout(() => cb('linha de teste\n'), 0)
      }),
      onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => {
        setTimeout(() => cb({ exitCode: 0 }), 0)
      }),
      write: vi.fn(),
      kill: vi.fn(),
      pid: 123,
    }
    const ptySpawnImpl = vi.fn(() => fakeIPty) as unknown as (
      file: string,
      args: string[],
      options: Record<string, unknown>
    ) => typeof fakeIPty
    const handle = runDeviceLogin({
      image: 'img',
      binary: 'claude',
      args: ['setup-token'],
      usePty: true,
      ptySpawnImpl,
      makeHomeImpl: () => '/tmp/gitorch-login-fixed/xyz',
    })
    const seen: string[] = []
    // Assina onStdout ANTES do tick em que o fake dispara os dados — assim
    // como o chamador real (AssistedLoginService.start()) faz na linha
    // síncrona seguinte ao runDeviceLogin().
    handle.onStdout((c) => seen.push(c))
    // O timer de onData foi agendado antes do de onExit (registrado primeiro
    // dentro de runViaPty), então por ordem de fila ele já disparou quando
    // `exited` resolve — sem precisar de uma espera de tick separada.
    const res = await handle.exited
    expect(seen.join('')).toContain('linha de teste')
    // O terminal precisa ser largo o bastante pra uma URL de OAuth de ~350
    // caracteres nunca quebrar em múltiplas linhas (achado real: sem isto, o
    // Claude e o Antigravity truncavam a URL de autorização).
    const [, , options] = ptySpawnImpl.mock.calls[0]!
    expect((options as { cols?: number }).cols).toBeGreaterThanOrEqual(400)
    expect(res.code).toBe(0)
  })

  it('writeStdin manda o código colado pro PTY (Claude/Antigravity)', () => {
    const fakeIPty = {
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      pid: 123,
    }
    const ptySpawnImpl = vi.fn(() => fakeIPty) as unknown as (
      file: string,
      args: string[],
      options: Record<string, unknown>
    ) => typeof fakeIPty
    const handle = runDeviceLogin({
      image: 'img',
      binary: 'claude',
      args: ['setup-token'],
      usePty: true,
      ptySpawnImpl,
      makeHomeImpl: () => '/tmp/gitorch-login-fixed/xyz',
    })
    handle.writeStdin('codigo-colado\n')
    expect(fakeIPty.write).toHaveBeenCalledWith('codigo-colado\n')
  })

  it('kill() encerra o PTY', () => {
    const fakeIPty = {
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      kill: vi.fn(),
      pid: 123,
    }
    const ptySpawnImpl = vi.fn(() => fakeIPty) as unknown as (
      file: string,
      args: string[],
      options: Record<string, unknown>
    ) => typeof fakeIPty
    const handle = runDeviceLogin({
      image: 'img',
      binary: 'claude',
      args: ['setup-token'],
      usePty: true,
      ptySpawnImpl,
      makeHomeImpl: () => '/tmp/gitorch-login-fixed/xyz',
    })
    handle.kill()
    expect(fakeIPty.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('writeStdin after the PTY process has already exited does not throw (node-pty write is a documented safe no-op)', async () => {
    const fakeIPty = {
      onData: vi.fn(),
      onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => {
        setTimeout(() => cb({ exitCode: 0 }), 0)
      }),
      // node-pty real: escrever num PTY já morto é um no-op seguro (não
      // lança). O fake espelha esse comportamento documentado.
      write: vi.fn(),
      kill: vi.fn(),
      pid: 123,
    }
    const ptySpawnImpl = vi.fn(() => fakeIPty) as unknown as (
      file: string,
      args: string[],
      options: Record<string, unknown>
    ) => typeof fakeIPty
    const handle = runDeviceLogin({
      image: 'img',
      binary: 'claude',
      args: ['setup-token'],
      usePty: true,
      ptySpawnImpl,
      makeHomeImpl: () => '/tmp/gitorch-login-fixed/xyz',
    })
    const res = await handle.exited
    expect(res.code).toBe(0)
    expect(() => handle.writeStdin('too-late-code\n')).not.toThrow()
  })

  it('um spawn que falha (exitCode != 0) resolve `exited` como falha, sem precisar de listener de erro separado (comportamento nativo do node-pty)', async () => {
    const fakeIPty = {
      onData: vi.fn(),
      onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => {
        setTimeout(() => cb({ exitCode: 1 }), 0)
      }),
      write: vi.fn(),
      kill: vi.fn(),
      pid: 123,
    }
    const ptySpawnImpl = vi.fn(() => fakeIPty) as unknown as (
      file: string,
      args: string[],
      options: Record<string, unknown>
    ) => typeof fakeIPty
    const handle = runDeviceLogin({
      image: 'img',
      binary: 'claude',
      args: ['setup-token'],
      usePty: true,
      ptySpawnImpl,
      makeHomeImpl: () => '/tmp/gitorch-login-fixed/xyz',
    })
    const res = await handle.exited
    expect(res.code).toBe(1)
  })
})
