import type { RuntimeCommandRunner } from '@gitorch/agents'

/** Um container que o `rm -f` NÃO confirmou removido, com o motivo. */
export interface ReapFailure {
  name: string
  stderr: string
}

/**
 * Resultado honesto da varredura: `removed` só contém nomes com `exitCode
 * === 0` confirmado no `rm -f`; tudo que foi tentado mas não confirmado cai
 * em `failed`. Nunca conflar "tentado" com "removido" — ver o incidente que
 * esta ceifa existe para prevenir (container segurando RAM enquanto o log
 * relata sucesso).
 */
export interface ReapResult {
  removed: string[]
  failed: ReapFailure[]
}

/**
 * Ceifador de BOOT (P2-2/E5): a execução de missão vive numa promise em
 * memória (scheduler.ts) — um restart do control-plane deixa (a) a linha
 * `running` fantasma no banco até a varredura de stale por idade e (b) o
 * container podman vivo segurando RAM/CPU numa VM compartilhada. A esteira de
 * DEPLOY drena missões em voo antes de trocar de versão (F2.3.2) — o boot
 * nunca encontra uma missão legitimamente ativa. Por isso: todo container
 * `gitorch-mission-*` é removido à força e toda missão `running` vira
 * `failed` IMEDIATAMENTE, com erro honesto (nunca "presa 2h").
 *
 * CONTRATO REAL do runner (ver realRuntimeCommandRunner em
 * packages/agents/src/runtime-adapter.ts): podman ausente (ENOENT), permissão
 * negada (EACCES) e timeout NÃO rejeitam a promise — resolvem com
 * `{exitCode: <não-zero>, stdout: '', stderr: <mensagem>}`. Por isso o
 * `exitCode` é inspecionado explicitamente em cada chamada (mesmo padrão de
 * packages/agents/src/podman-runner.ts, que checa `exitCode === 124` no
 * timeout) — um `.catch` sozinho nunca veria essas falhas.
 */
export async function reapOrphanContainers(
  run: RuntimeCommandRunner,
  engine: string
): Promise<ReapResult> {
  const list = await run({
    binary: engine,
    args: ['ps', '-a', '--filter', 'name=gitorch-mission-', '--format', '{{.Names}}'],
    env: {},
  })
  if (list.exitCode !== 0) {
    // Listagem falhou de verdade (podman ausente, socket sem permissão) — sem
    // isto, stdout vazio é indistinguível de "zero órfãos" e a falha nunca é
    // logada. Propaga para o chamador decidir logar e seguir (mesmo contrato
    // já coberto pelo caso de `run` rejeitando).
    throw new Error(
      `\`${engine} ps\` falhou (exitCode=${list.exitCode}): ${list.stderr || '(sem stderr)'}`
    )
  }
  const names = list.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  const removed: string[] = []
  const failed: ReapFailure[] = []
  for (const name of names) {
    // Best-effort por container: um `rm` isolado falhando (já removido por
    // outro processo, corrida de gc do próprio podman) não pode abortar a
    // limpeza dos demais órfãos da lista. `run` pode devolver síncrono
    // (RuntimeCommandRunner permite as duas formas) — Promise.resolve
    // normaliza antes de inspecionar o resultado.
    try {
      const result = await Promise.resolve(
        run({ binary: engine, args: ['rm', '-f', name], env: {} })
      )
      if (result.exitCode === 0) {
        removed.push(name)
      } else {
        failed.push({ name, stderr: result.stderr || '(sem stderr)' })
      }
    } catch (error: unknown) {
      // Caminho genuinamente excepcional (não o contrato real do runner, mas
      // coberto por segurança): mesmo tratamento de "não removido".
      failed.push({ name, stderr: error instanceof Error ? error.message : String(error) })
    }
  }
  return { removed, failed }
}

/**
 * `bootAt` (achado M1) delimita o que este ceifador pode legitimamente
 * considerar órfão: só missão com `startedAt` ANTES do boot — ou seja,
 * criada pelo processo ANTERIOR, que morreu. Sem esse filtro, uma missão
 * disparada de verdade pela rota admin/QA no intervalo entre `listen()`
 * resolver e este ceifador terminar (no caminho podman, `ps` + N × `rm -f`
 * pode levar segundos) é marcada `failed` enquanto ainda roda genuinamente —
 * ela nasce DEPOIS do boot, então nunca pode ter sido deixada pelo processo
 * anterior. `bootAt` é capturado no registro do plugin (scheduler.ts), antes
 * de `app.listen()` sequer devolver — nenhuma requisição HTTP (logo, nenhum
 * dispatch de missão) é possível antes disso.
 */
export async function failOrphanRunningMissions(
  prisma: {
    mission: { updateMany(args: unknown): Promise<{ count: number }> }
  },
  bootAt: Date
): Promise<number> {
  const res = await prisma.mission.updateMany({
    where: { status: 'running', startedAt: { lt: bootAt } },
    data: {
      status: 'failed',
      error:
        'Órfã de restart do control-plane: o processo que a executava morreu (ceifador de boot)',
      completedAt: new Date(),
    },
  })
  return res.count
}
