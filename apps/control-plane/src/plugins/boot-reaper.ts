import type { RuntimeCommandRunner } from '@gitorch/agents'

/**
 * Ceifador de BOOT (P2-2/E5): a execução de missão vive numa promise em
 * memória (scheduler.ts) — um restart do control-plane deixa (a) a linha
 * `running` fantasma no banco até a varredura de stale por idade e (b) o
 * container podman vivo segurando RAM/CPU numa VM compartilhada. A esteira de
 * DEPLOY drena missões em voo antes de trocar de versão (F2.3.2) — o boot
 * nunca encontra uma missão legitimamente ativa. Por isso: todo container
 * `gitorch-mission-*` é removido à força e toda missão `running` vira
 * `failed` IMEDIATAMENTE, com erro honesto (nunca "presa 2h").
 */
export async function reapOrphanContainers(
  run: RuntimeCommandRunner,
  engine: string
): Promise<string[]> {
  const list = await run({
    binary: engine,
    args: ['ps', '-a', '--filter', 'name=gitorch-mission-', '--format', '{{.Names}}'],
    env: {},
  })
  const names = list.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const name of names) {
    // Best-effort por container: um `rm` isolado falhando (já removido por
    // outro processo, corrida de gc do próprio podman) não pode abortar a
    // limpeza dos demais órfãos da lista. `run` pode devolver síncrono
    // (RuntimeCommandRunner permite as duas formas) — Promise.resolve
    // normaliza antes de encadear `.catch`.
    await Promise.resolve(run({ binary: engine, args: ['rm', '-f', name], env: {} })).catch(
      () => undefined
    )
  }
  return names
}

export async function failOrphanRunningMissions(prisma: {
  mission: { updateMany(args: unknown): Promise<{ count: number }> }
}): Promise<number> {
  const res = await prisma.mission.updateMany({
    where: { status: 'running' },
    data: {
      status: 'failed',
      error:
        'Órfã de restart do control-plane: o processo que a executava morreu (ceifador de boot)',
      completedAt: new Date(),
    },
  })
  return res.count
}
