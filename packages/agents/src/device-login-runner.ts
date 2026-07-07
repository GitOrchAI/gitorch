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
  // Sem isto, um EPIPE ao escrever num stdin já torn-down (container morto
  // antes de um writeStdin atrasado, ex.: submitCode que perdeu a corrida com
  // cleanup()) seria um 'error' sem listener no stdin — Node trata isso como
  // exceção não tratada e derruba o processo INTEIRO do control-plane (não só
  // a sessão do usuário). Não há nada de acionável a fazer aqui: quem chamou
  // writeStdin não tem como saber de forma síncrona que falhou, e escrever
  // num processo já morto não é um erro que o chamador deveria tratar.
  proc.stdin?.on('error', () => undefined)

  // Resolve exatamente uma vez, a partir de QUALQUER UM dos dois eventos que
  // podem chegar primeiro: 'close' (saída normal) ou 'error' (o processo nem
  // conseguiu subir — binário ausente, limite de recursos, etc.). Sem um
  // listener de 'error' aqui, o mesmo problema do stdin acima se repete: o
  // `proc` é um EventEmitter e um 'error' sem listener derruba o processo
  // inteiro do control-plane, não só a requisição que disparou o spawn.
  // 'close' pode nunca disparar depois de um erro de spawn, então o guard
  // best-effort de "resolver uma vez só" cobre ambas as ordens possíveis.
  let resolveExited: (result: { code: number | null }) => void
  const exited = new Promise<{ code: number | null }>((resolve) => {
    resolveExited = resolve
  })
  let settled = false
  const settleExited = (result: { code: number | null }): void => {
    if (settled) return
    settled = true
    resolveExited(result)
  }
  proc.on('close', (code: number | null) => settleExited({ code }))
  // `code: null` aqui é tratado como falha por AssistedLoginService.onExit:
  // runtimes não-claude checam `code !== 0` (null !== 0 → falha) e o ramo
  // claude falha incondicionalmente quando `capturing` ainda não foi setado
  // (nunca chegou a capturar token nenhum, já que o processo nem subiu).
  proc.on('error', () => settleExited({ code: null }))

  return {
    hostHome,
    onStdout: (cb) => cbs.push(cb),
    writeStdin: (data) => proc.stdin?.write(data),
    exited,
    kill: () => proc.kill('SIGTERM'),
  }
}
