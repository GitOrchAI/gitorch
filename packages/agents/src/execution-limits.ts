import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * Teto de CPU/memória por execução de agente. Sem isto, um CLI agêntico solto
 * (loop, vazamento de memória, prompt hostil) consome a VM inteira e derruba o
 * resto do control plane — não há isolamento de container aqui (execFile
 * direto no host), só o cgroup transitório que o `systemd-run --scope` cria
 * por processo.
 *
 * Modo controlado por GITORCH_EXEC_LIMITS: 'systemd' aplica o wrapper — mas só
 * quando o binário `systemd-run` REALMENTE existe no PATH; sem ele, degrada
 * pro comando cru em vez de falhar a missão inteira por causa de uma peça de
 * infra ausente (ex.: ambiente de teste, VM sem systemd de usuário). Qualquer
 * outro valor — inclusive ausente, o default em teste/CI/produção não
 * configurada — devolve o comando intacto: comportamento idêntico ao que
 * existia antes desta mudança.
 */
export type ExecutionLimitsMode = 'systemd' | 'none'

export interface ExecutionLimits {
  /** Ex.: '2G'. Vira `-p MemoryMax=<memoryMax>` do systemd-run. */
  memoryMax: string
  /** Ex.: '150%'. Vira `-p CPUQuota=<cpuQuota>` do systemd-run. */
  cpuQuota: string
}

export interface WrappedCommand {
  binary: string
  args: string[]
}

export interface WrapWithLimitsOptions {
  /** Override para teste; default lê o ambiente real do processo. */
  env?: NodeJS.ProcessEnv
}

const SYSTEMD_RUN_BINARY = 'systemd-run'

export function resolveExecutionLimitsMode(
  env: NodeJS.ProcessEnv = process.env
): ExecutionLimitsMode {
  return env['GITORCH_EXEC_LIMITS'] === 'systemd' ? 'systemd' : 'none'
}

/**
 * Busca burra do binário nos diretórios do PATH — a mesma técnica que um
 * shell usaria para resolver um comando, sem depender de spawnar `which`
 * (mais barato e não falha silenciosamente em PATH vazio/malformado).
 */
export function isBinaryOnPath(binary: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const rawPath = env['PATH'] ?? ''
  if (!rawPath) return false
  return rawPath.split(delimiter).some((dir) => {
    if (!dir) return false
    try {
      return existsSync(join(dir, binary))
    } catch {
      return false
    }
  })
}

/**
 * Prefixa `cmd args` com `systemd-run --scope --quiet -p MemoryMax=<x> -p
 * CPUQuota=<y> --` quando o modo é 'systemd' E o binário existe no PATH. Em
 * qualquer outro caso devolve o comando intacto (cru) — nunca lança.
 */
export function wrapWithLimits(
  cmd: string,
  args: string[],
  limits: ExecutionLimits,
  options: WrapWithLimitsOptions = {}
): WrappedCommand {
  const env = options.env ?? process.env
  const mode = resolveExecutionLimitsMode(env)

  if (mode !== 'systemd' || !isBinaryOnPath(SYSTEMD_RUN_BINARY, env)) {
    return { binary: cmd, args }
  }

  return {
    binary: SYSTEMD_RUN_BINARY,
    args: [
      '--user',
      '--scope',
      '--quiet',
      '-p',
      `MemoryMax=${limits.memoryMax}`,
      '-p',
      `CPUQuota=${limits.cpuQuota}`,
      '--',
      cmd,
      ...args,
    ],
  }
}
