import type { RuntimeCommandRunner } from './runtime-adapter.js'
import { realRuntimeCommandRunner } from './runtime-adapter.js'

export interface SshCommandRunnerOptions {
  /** Destino SSH, ex.: 'gitorch@<TAILSCALE_IP>' (host/IP Tailscale do nó remoto). */
  host: string
  /** Caminho da chave privada dedicada (nunca a chave ampla do host). */
  identityFile: string
  /** Binário ssh (injetável para teste). Default 'ssh'. */
  sshBinary?: string
  /** Opções extras de ssh, inseridas antes do host (ex.: ConnectTimeout). */
  extraSshArgs?: string[]
  /** Runner que executa o ssh de fato (injetável para teste). */
  inner?: RuntimeCommandRunner
}

/**
 * Faz um RuntimeCommandRunner rodar o comando em OUTRA máquina via SSH.
 *
 * Composição: passe isto como `hostRunner` do createPodmanCommandRunner e o
 * `podman run` da missão executa num nó remoto (ex.: MT-SaaS) por Tailscale,
 * como o usuário isolado `gitorch`. O binário e os argumentos são shell-quotados
 * e entregues como UM único comando remoto — argumentos com espaço/aspas são
 * preservados. O processo ssh local roda com env vazio: nada do control plane
 * vaza para o ssh; o ambiente DENTRO do container vem dos `-e` já embutidos nos
 * argumentos do podman.
 */
export function createSshCommandRunner(options: SshCommandRunnerOptions): RuntimeCommandRunner {
  const inner = options.inner ?? realRuntimeCommandRunner
  const sshBinary = options.sshBinary ?? 'ssh'

  return async (request) => {
    const remoteCommand = shellQuote([request.binary, ...request.args])
    const args = [
      '-i',
      options.identityFile,
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      ...(options.extraSshArgs ?? []),
      options.host,
      remoteCommand,
    ]

    return inner({
      binary: sshBinary,
      args,
      // env vazio: o ssh local nunca herda segredos do control plane.
      env: {},
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
    })
  }
}

/**
 * Quota cada token para o shell POSIX remoto usando aspas simples; a própria
 * aspa simples vira a sequência `'\''` (fecha, aspa escapada, reabre).
 */
function shellQuote(argv: string[]): string {
  return argv.map((token) => `'${token.replace(/'/g, `'\\''`)}'`).join(' ')
}
