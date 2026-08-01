/** Default do teto de CPU por missão (podman --cpus): a conta de capacidade
 *  da MT-SaaS (8-10 missões em paralelo). Ver GITORCH_MISSION_CPUS no
 *  .env.example e plugins/scheduler.ts. */
export const DEFAULT_MISSION_CPUS = '1.5'

/**
 * Resolve o teto de CPU por missão a partir de GITORCH_MISSION_CPUS.
 *
 * `??` sozinho só cai no default com null/undefined — uma env PRESENTE mas
 * vazia (`GITORCH_MISSION_CPUS=`, erro comum de .env/systemd/compose) vira
 * `''`, que o gate do podman-runner (`options.cpus ? [...] : []`) trata como
 * falsy: nenhum `--cpus` é emitido e a missão roda sem teto — exatamente a
 * fuga que esta task existe para fechar, e em silêncio. Por isso tudo que não
 * for um número finito e estritamente positivo (ausente, vazio/só espaço,
 * não-numérico, zero ou negativo) cai no default: um operador string não
 * validado não é confiável para um teto de segurança.
 */
export function resolveMissionCpus(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['GITORCH_MISSION_CPUS']?.trim()
  if (!raw) return DEFAULT_MISSION_CPUS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MISSION_CPUS
  return raw
}
