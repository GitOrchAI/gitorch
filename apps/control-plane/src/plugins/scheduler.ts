import fp from 'fastify-plugin'
import { FastifyInstance } from 'fastify'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AgentOrchestrator,
  RuntimeRegistry,
  createCliRuntimeAdapter,
  createPythonSdkRuntimeAdapter,
  type F6AgentRole,
  type WorkspaceProvider,
} from '@gitorch/agents'
import { LocalWorkspaceProvider, WorkspaceManager } from '@gitorch/workspace-engine'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// dist/plugins -> raiz do repo -> runtime/
const runtimeScriptPath = path.resolve(__dirname, '../../../../runtime/run_antigravity_sdk.py')

export interface SchedulerOptions {
  // Empty options type
}

// Guardas operacionais (design doc 2026-07-03): orçamento de tokens e RAM da VM.
const MAX_MISSIONS_PER_DAY = Number(process.env['GITORCH_MAX_MISSIONS_PER_DAY'] ?? '4')
const STALE_RUNNING_MS = Number(
  process.env['GITORCH_STALE_RUNNING_MS'] ?? String(2 * 60 * 60 * 1000)
)
// Nomes de modelo do Antigravity CLI (agy models) — plano de ignição 2026-07-02.
const MODEL_FLASH = process.env['GITORCH_MODEL_FLASH'] ?? 'Gemini 3.5 Flash (Medium)'
const MODEL_PRO = process.env['GITORCH_MODEL_PRO'] ?? 'Gemini 3.1 Pro (Low)'

// PO decide (modelo forte); RA/SM/QA analisam (modelo rápido) — plano de ignição 2026-07-02.
const MODEL_BY_ROLE: Record<F6AgentRole, string> = {
  po: MODEL_PRO,
  ra: MODEL_FLASH,
  sm: MODEL_FLASH,
  qa: MODEL_FLASH,
}

function buildWorkspaceProvider(app: FastifyInstance): WorkspaceProvider {
  const executor = process.env['GITORCH_EXECUTOR'] ?? 'local-process'
  if (executor === 'firecracker') {
    app.log.info('[Scheduler] Executor: firecracker (MicroVM por tenant)')
    return new WorkspaceManager()
  }
  // Default: esta VM não tem /dev/kvm, então Firecracker é inviável aqui.
  app.log.info('[Scheduler] Executor: local-process (sem MicroVM; single-tenant)')
  return new LocalWorkspaceProvider()
}

const schedulerPlugin = fp<SchedulerOptions>(async (app: FastifyInstance) => {
  const registry = new RuntimeRegistry()

  // Motor principal: Antigravity CLI autenticado por OAuth (diretriz do owner
  // 2026-07-03: todos os motores logam por OAuth, nunca por chave de API).
  // GITORCH_ANTIGRAVITY_MODE=api mantém a ponte REST apenas para diagnóstico.
  if (process.env['GITORCH_ANTIGRAVITY_MODE'] === 'api') {
    registry.register(
      createPythonSdkRuntimeAdapter({
        runtime: 'antigravity',
        scriptPath: runtimeScriptPath,
      })
    )
  } else {
    // Sem flags que desliguem aprovações de ferramenta: o modo --print roda
    // leitura/análise sem prompts. Flags extras (ex.: --sandbox) só entram por
    // decisão explícita do owner via GITORCH_AGY_EXTRA_ARGS.
    const agyExtraArgs = (process.env['GITORCH_AGY_EXTRA_ARGS'] ?? '').split(' ').filter(Boolean)
    registry.register(
      createCliRuntimeAdapter({
        runtime: 'antigravity',
        binary: process.env['GITORCH_AGY_BIN'] ?? '/home/ubuntu/.local/bin/agy',
        args: ['--print', ...agyExtraArgs],
        modelArgName: '--model',
      })
    )
  }

  // Fallback declarado: Codex CLI via OAuth (exige `codex login` prévio na VM).
  registry.register(
    createCliRuntimeAdapter({
      runtime: 'codex',
      binary: 'codex',
      args: ['exec'],
    })
  )

  const orchestrator = new AgentOrchestrator({
    registry,
    workspace: buildWorkspaceProvider(app),
  })

  const failStaleRunningMissions = async (): Promise<void> => {
    const staleBefore = new Date(Date.now() - STALE_RUNNING_MS)
    const stale = await app.prisma.mission.updateMany({
      where: { status: 'running', startedAt: { lt: staleBefore } },
      data: {
        status: 'failed',
        error: `Mission stale: em "running" por mais de ${Math.round(STALE_RUNNING_MS / 60000)} minutos sem concluir`,
        completedAt: new Date(),
      },
    })
    if (stale.count > 0) {
      app.log.warn(`[Scheduler] ${stale.count} missão(ões) travadas marcadas como failed`)
    }
  }

  const triggerAgentMission = async (role: F6AgentRole) => {
    app.log.info(`[Scheduler] Triggering agent mission for role: ${role}`)
    try {
      await failStaleRunningMissions()

      // Concorrência 1: a VM tem ~3,6 GB livres; uma missão por vez.
      const running = await app.prisma.mission.count({ where: { status: 'running' } })
      if (running > 0) {
        app.log.warn(`[Scheduler] Missão em andamento; pulando janela de ${role}`)
        return
      }

      // Orçamento: no máximo N missões/dia por agente (tokens custam créditos).
      const startOfDay = new Date()
      startOfDay.setHours(0, 0, 0, 0)
      const todayCount = await app.prisma.mission.count({
        where: { type: `agent-run-${role}`, createdAt: { gte: startOfDay } },
      })
      if (todayCount >= MAX_MISSIONS_PER_DAY) {
        app.log.warn(
          `[Scheduler] Orçamento diário de ${role} atingido (${todayCount}/${MAX_MISSIONS_PER_DAY}); pulando`
        )
        return
      }

      const project = await app.prisma.project.findFirst({
        where: { isActive: true },
      })

      if (!project) {
        app.log.warn('[Scheduler] No active project found to trigger mission')
        return
      }

      const mission = await app.prisma.mission.create({
        data: {
          projectId: project.id,
          type: `agent-run-${role}`,
          status: 'pending',
          payload: {
            role,
            triggeredBy: 'scheduler',
            runtime: 'antigravity',
            model: MODEL_BY_ROLE[role],
          },
        },
      })

      app.log.info(`[Scheduler] Mission created in DB: ${mission.id} for role ${role}`)

      // Execute the mission asynchronously
      // Since it takes time, we run it in background and catch errors
      app.prisma.mission
        .update({
          where: { id: mission.id },
          data: { status: 'running', startedAt: new Date() },
        })
        .then(async () => {
          const result = await orchestrator.runMission({
            id: mission.id,
            projectId: project.id,
            repository: project.wingId, // e.g. loureng/patinhas-3d-crafts
            role: role,
            goal: `Analyze and coordinate tasks for ${project.name}`,
            context: [],
            runtime: { runtime: 'antigravity', model: MODEL_BY_ROLE[role] },
            credentialRef: {
              connectionId: `conn-${role}-${Date.now()}`,
              ownerScope: 'project',
              runtime: 'antigravity',
              providedSecrets: [],
            },
            userId: 'scheduler-user',
          })

          await app.prisma.mission.update({
            where: { id: mission.id },
            data: {
              status: result.exitCode === 0 ? 'completed' : 'failed',
              completedAt: new Date(),
              error: result.exitCode === 0 ? null : result.stderr.slice(0, 4000),
              result: {
                output: result.output,
                stderr: result.stderr,
              },
            },
          })

          app.log.info(
            `[Scheduler] Mission completed: ${mission.id} with exitCode: ${result.exitCode}`
          )
        })
        .catch(async (err) => {
          app.log.error(err, `[Scheduler] Failed to execute mission ${mission.id}`)
          // Nunca mascarar: falha vira status failed com erro legível no banco.
          try {
            await app.prisma.mission.update({
              where: { id: mission.id },
              data: {
                status: 'failed',
                completedAt: new Date(),
                error: String(err?.stack ?? err).slice(0, 4000),
              },
            })
          } catch (persistErr) {
            app.log.error(persistErr, `[Scheduler] Failed to persist failure for ${mission.id}`)
          }
        })
    } catch (err) {
      app.log.error(err, `[Scheduler] Error triggering agent mission for role ${role}`)
    }
  }

  // Simple cron-like scheduler running check loop
  const tick = async () => {
    const now = new Date()
    const localHours = now.getHours()
    const localMinutes = now.getMinutes()

    app.log.info(`[Scheduler] Tick at ${localHours}:${localMinutes}`)

    // Only run on the hour (minutes === 0)
    if (localMinutes !== 0) {
      return
    }

    // RA: starts at 00:00 AM (0 hours)
    if (localHours === 0) {
      await triggerAgentMission('ra')
    }

    // PO: starts at 03:00 AM (every 12 hours -> 3 and 15)
    if (localHours === 3 || localHours === 15) {
      await triggerAgentMission('po')
    }

    // SM: starts at 05:00 AM (every 6 hours -> 5, 11, 17, 23)
    if (localHours === 5 || localHours === 11 || localHours === 17 || localHours === 23) {
      await triggerAgentMission('sm')
    }
  }

  // Run check loop every minute
  const intervalId = setInterval(tick, 60 * 1000)

  // Clean up interval on app close
  app.addHook('onClose', async () => {
    clearInterval(intervalId)
  })

  // Exposto para rotas administrativas e QA real dispararem missões sob demanda.
  app.decorate('triggerAgentMission', triggerAgentMission)
})

declare module 'fastify' {
  interface FastifyInstance {
    triggerAgentMission: (role: F6AgentRole) => Promise<void>
  }
}

export default schedulerPlugin
export { schedulerPlugin }
