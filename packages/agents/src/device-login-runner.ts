import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// HOME dentro do container (bind-mount de um dir do host, para a credencial que
// o login grava SOBREVIVER ao --rm e poder ser capturada).
const CONTAINER_HOME = '/home/agent'

export interface DeviceLoginHandle {
  /** Dir do host montado como HOME do container; feed para captureFromHome. */
  hostHome: string
  onStdout: (cb: (chunk: string) => void) => void
  /** Escreve no stdin do processo (ex.: o código que o usuário cola — Claude). */
  writeStdin: (data: string) => void
  exited: Promise<{ code: number | null }>
  kill: () => void
}

export interface DeviceLoginOptions {
  /** Imagem do agente (GITORCH_AGENT_IMAGE) — já traz codex/claude/agy. */
  image: string
  binary: string
  args: string[]
  /** Aloca um TTY (-t): o `claude setup-token` só emite a URL sob PTY. */
  usePty?: boolean
  podmanBinary?: string
  memoryLimit?: string
  pidsLimit?: number
  // Injetáveis para teste:
  spawnImpl?: typeof nodeSpawn
  /** Cria (e retorna) o dir do host que vira o HOME do container. Default: mkdtemp. */
  makeHomeImpl?: () => string
}

/**
 * Roda o login de um motor DENTRO de um container descartável e devolve um
 * handle que faz streaming do stdout (para parsear o device-code/URL), aceita
 * stdin (para o código colado do Claude), expõe o HOME do host (para capturar a
 * credencial após a aprovação) e permite matar o processo. Diferente do
 * podman-runner de missão (one-shot, HOME em tmpfs efêmero), aqui o HOME é
 * bind-mount do host: a credencial gravada pelo login PERSISTE após o --rm.
 */
export function runDeviceLogin(options: DeviceLoginOptions): DeviceLoginHandle {
  const spawn = options.spawnImpl ?? nodeSpawn
  const podmanBinary = options.podmanBinary ?? 'podman'
  const hostHome = options.makeHomeImpl
    ? options.makeHomeImpl()
    : mkdtempSync(path.join(os.tmpdir(), 'gitorch-login-'))

  const args: string[] = [
    'run',
    '--rm',
    '-i', // stdin aberto: o Claude lê o código colado; inofensivo para os demais.
    ...(options.usePty ? ['-t'] : []),
    '--userns=keep-id', // rootless: a credencial gravada no bind-mount fica legível pelo host.
    '--memory',
    options.memoryLimit ?? '2g',
    '--pids-limit',
    String(options.pidsLimit ?? 512),
    '--tmpfs',
    '/tmp:rw,exec',
    // HOME = bind-mount do host (NÃO tmpfs): a credencial sobrevive ao --rm.
    '-v',
    `${hostHome}:${CONTAINER_HOME}:rw`,
    '-e',
    `HOME=${CONTAINER_HOME}`,
    '-e',
    'XDG_RUNTIME_DIR=/tmp',
    options.image,
    options.binary,
    ...options.args,
  ]

  const proc = spawn(podmanBinary, args, { stdio: ['pipe', 'pipe', 'pipe'] })

  const cbs: Array<(chunk: string) => void> = []
  proc.stdout?.on('data', (d: Buffer | string) => {
    const s = typeof d === 'string' ? d : d.toString('utf8')
    for (const cb of cbs) cb(s)
  })

  const exited = new Promise<{ code: number | null }>((resolve) => {
    proc.on('close', (code: number | null) => resolve({ code }))
  })

  return {
    hostHome,
    onStdout: (cb) => cbs.push(cb),
    writeStdin: (data) => proc.stdin?.write(data),
    exited,
    kill: () => proc.kill('SIGTERM'),
  }
}
