import { access } from 'node:fs/promises'
import type {
  RuntimeCommandRequest,
  RuntimeCommandResult,
  RuntimeCommandRunner,
} from './runtime-adapter.js'

// Achado importante da revisão pós-merge: `createPodmanCommandRunner` (ver
// podman-runner.ts) só recusa uma missão sem o plugin de segurança do
// GitOrch quando GITORCH_EXECUTOR=podman. O DEFAULT do executor é
// 'local-process' — o que a CI usa, e o que roda em qualquer host sem
// /dev/kvm — e nesse caminho `--dangerously-skip-permissions` (fixa no
// código, ver AGY_SKIP_PERMISSIONS_FLAG em scheduler.ts) seguia sendo
// aplicada sem NENHUMA verificação equivalente. Regra do dono, literal:
// "nunca existe agente solto sem trava".
//
// Sem container, não há imagem pra checar — o equivalente é um marcador no
// próprio HOST que executa o processo do agente (mesmo princípio: um
// arquivo que só existe se o plugin de hooks do GitOrch foi instalado ali).
// Path configurável porque, ao contrário do container (imagem única,
// controlada por nós), o host local varia por instalação/operador.

const DEFAULT_LOCAL_PLUGIN_MARKER_PATH = '/opt/gitorch-plugin/gitorch/hooks.json'

/**
 * Lido do env A CADA chamada (nunca congelado num `const` de módulo): tanto
 * produção (o operador pode setar a env antes de subir o processo, mas
 * também é o único jeito de um teste isolar o path sem reimportar o módulo)
 * quanto o wrapper abaixo dependem de pegar o valor ATUAL, não o de quando
 * o módulo foi importado pela primeira vez.
 */
export function resolveLocalPluginMarkerPath(explicit?: string): string {
  return explicit ?? process.env['GITORCH_LOCAL_PLUGIN_MARKER'] ?? DEFAULT_LOCAL_PLUGIN_MARKER_PATH
}

export function buildHostPluginMissingMessage(markerPath: string): string {
  return (
    `GitOrch: missão recusada — o host de execução (modo local-process) está sem o gate de ` +
    `segurança do GitOrch (${markerPath} não encontrado). Sem o plugin instalado, ` +
    `--dangerously-skip-permissions ficaria sem NENHUMA trava real. Execução negada.`
  )
}

export const GITORCH_HOST_PLUGIN_MISSING_MESSAGE = buildHostPluginMissingMessage(
  DEFAULT_LOCAL_PLUGIN_MARKER_PATH
)

export const GITORCH_HOST_PLUGIN_DISABLED_MESSAGE =
  'GitOrch: missão recusada — GITORCH_AGY_PLUGIN=0 desliga o plugin de segurança do GitOrch ' +
  'no host de execução. Sem o plugin ativo, --dangerously-skip-permissions ficaria sem NENHUMA ' +
  'trava real. Execução negada.'

/** Verifica se o marcador do plugin existe no HOST local. Barato (um stat), sem cache — ao
 *  contrário do container (que paga um `podman run` inteiro pra checar), aqui não há custo
 *  que justifique arriscar servir um `false` transitório (ex.: disco montando) para sempre. */
export async function isGitorchPluginPresentOnHost(markerPath?: string): Promise<boolean> {
  try {
    await access(resolveLocalPluginMarkerPath(markerPath))
    return true
  } catch {
    return false
  }
}

/**
 * Envolve um RuntimeCommandRunner de execução LOCAL (sem container) com a
 * mesma trava que o caminho podman já tem: nenhuma missão roda sem confirmar
 * que o plugin de segurança do GitOrch está de pé — aqui, no HOST, não numa
 * imagem. `GITORCH_AGY_PLUGIN=0` recusa pelo mesmo motivo que no container
 * (fuga explícita = ainda sem trava real).
 */
export function wrapWithHostGitorchPluginGate(
  runner: RuntimeCommandRunner,
  markerPath?: string
): RuntimeCommandRunner {
  return async (request: RuntimeCommandRequest): Promise<RuntimeCommandResult> => {
    if ((process.env['GITORCH_AGY_PLUGIN'] ?? '1') === '0') {
      return {
        exitCode: 1,
        stdout: '',
        stderr: GITORCH_HOST_PLUGIN_DISABLED_MESSAGE,
        durationMs: 0,
      }
    }
    const resolvedMarker = resolveLocalPluginMarkerPath(markerPath)
    const present = await isGitorchPluginPresentOnHost(resolvedMarker)
    if (!present) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: buildHostPluginMissingMessage(resolvedMarker),
        durationMs: 0,
      }
    }
    return runner(request)
  }
}
