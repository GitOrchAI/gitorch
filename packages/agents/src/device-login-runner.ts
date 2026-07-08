import { spawn as nodeSpawn } from 'node:child_process'
import { spawn as ptySpawnDefault } from 'node-pty-prebuilt-multiarch'
import { mkdtempSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// HOME dentro do container (bind-mount de um dir do host, para a credencial que
// o login grava SOBREVIVER ao --rm e poder ser capturada).
const CONTAINER_HOME = '/home/agent'

// Largo o bastante pra uma URL de OAuth de ~350-400 caracteres NUNCA quebrar
// em múltiplas linhas dentro do terminal do container. Achado real (08/07):
// sem isto, `claude setup-token` e o `agy` imprimem a URL de autorização
// quebrada a cada ~80 colunas, e o parser (device-prompt-parser.ts) só
// capturava a 1ª linha, perdendo o resto (ex.: `redirect_uri`) — o provider
// então rejeitava a autorização com "parâmetro ausente".
const PTY_COLS = 400
const PTY_ROWS = 50

type PtySpawn = typeof ptySpawnDefault
type IPty = ReturnType<PtySpawn>

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
  /**
   * Aloca um PTY REAL do lado do host (não só `-t` pro podman, que sozinho não
   * dá ao container um tamanho de terminal válido). Necessário para: (1) o
   * Claude/Antigravity imprimirem a URL de OAuth inteira numa linha só (sem
   * PTY real, ela quebra em ~80 colunas e trunca); (2) o Antigravity conseguir
   * desenhar o menu "Select login method" (sem tamanho de terminal válido,
   * ele fica preso pra sempre sem imprimir nada). Codex não precisa (usePty
   * falso, continua no caminho de pipes simples de sempre).
   */
  usePty?: boolean
  podmanBinary?: string
  memoryLimit?: string
  pidsLimit?: number
  // Injetáveis para teste:
  spawnImpl?: typeof nodeSpawn
  ptySpawnImpl?: PtySpawn
  /** Cria (e retorna) o dir do host que vira o HOME do container. Default: mkdtemp. */
  makeHomeImpl?: () => string
}

function buildArgs(options: DeviceLoginOptions, hostHome: string): string[] {
  return [
    'run',
    '--rm',
    '-i', // stdin aberto: o Claude/Antigravity leem o código colado; inofensivo para os demais.
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
}

/**
 * Caminho via PTY real (Claude/Antigravity). `node-pty-prebuilt-multiarch` já
 * é seguro por padrão nos dois casos que o caminho de pipes abaixo precisa
 * de proteção manual para: um `spawn` que falha (binário ausente etc.) NÃO
 * lança exceção síncrona — `onExit` dispara com um exit code não-zero; e um
 * `.write()` depois do processo já ter saído NÃO lança (é um no-op seguro).
 * Confirmado empiricamente (não é suposição) — ver o plano desta correção.
 */
function runViaPty(
  options: DeviceLoginOptions,
  podmanBinary: string,
  args: string[],
  hostHome: string
): DeviceLoginHandle {
  const spawnPty = options.ptySpawnImpl ?? ptySpawnDefault
  const ptyProcess: IPty = spawnPty(podmanBinary, args, {
    name: 'xterm-256color',
    cols: PTY_COLS,
    rows: PTY_ROWS,
  })

  // node-pty entrega dados via `onData` de forma sempre assíncrona (evento
  // real de net.Socket/libuv — nunca dispara antes do próximo tick). Como
  // `runDeviceLogin` não tem nenhum `await` entre o spawn e o retorno do
  // handle, e quem chama (AssistedLoginService.start()) assina `onStdout` na
  // linha seguinte, síncrona, a assinatura SEMPRE chega antes do primeiro
  // chunk possível — não há necessidade de bufferizar/repetir dados para
  // assinantes tardios.
  const cbs: Array<(chunk: string) => void> = []
  ptyProcess.onData((data: string) => {
    for (const cb of cbs) cb(data)
  })

  let resolveExited: (result: { code: number | null }) => void
  const exited = new Promise<{ code: number | null }>((resolve) => {
    resolveExited = resolve
  })
  ptyProcess.onExit(({ exitCode }: { exitCode: number; signal?: number }) => {
    resolveExited({ code: exitCode })
  })

  return {
    hostHome,
    onStdout: (cb) => cbs.push(cb),
    writeStdin: (data) => ptyProcess.write(data),
    exited,
    kill: () => ptyProcess.kill('SIGTERM'),
  }
}

/**
 * Caminho de pipes simples (Codex — não precisa de PTY real, o device-auth do
 * Codex funciona headless). INALTERADO em relação à versão anterior desta
 * função — nenhuma mudança de comportamento aceitável aqui.
 */
function runViaPipes(
  options: DeviceLoginOptions,
  podmanBinary: string,
  args: string[],
  hostHome: string
): DeviceLoginHandle {
  const spawn = options.spawnImpl ?? nodeSpawn
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

/**
 * Roda o login de um motor DENTRO de um container descartável e devolve um
 * handle que faz streaming do stdout (para parsear o device-code/URL), aceita
 * stdin (para o código colado do Claude/Antigravity), expõe o HOME do host
 * (para capturar a credencial após a aprovação) e permite matar o processo.
 * Diferente do podman-runner de missão (one-shot, HOME em tmpfs efêmero),
 * aqui o HOME é bind-mount do host: a credencial gravada pelo login PERSISTE
 * após o --rm.
 *
 * `usePty:true` (Claude/Antigravity) usa um PTY real do host
 * (`runViaPty`) — sem isso, a URL de OAuth trunca e o Antigravity nunca
 * desenha seu menu. `usePty:false`/ausente (Codex) usa pipes simples
 * (`runViaPipes`), inalterado.
 */
export function runDeviceLogin(options: DeviceLoginOptions): DeviceLoginHandle {
  const podmanBinary = options.podmanBinary ?? 'podman'
  const hostHome = options.makeHomeImpl
    ? options.makeHomeImpl()
    : mkdtempSync(path.join(os.tmpdir(), 'gitorch-login-'))
  const args = buildArgs(options, hostHome)

  return options.usePty
    ? runViaPty(options, podmanBinary, args, hostHome)
    : runViaPipes(options, podmanBinary, args, hostHome)
}
