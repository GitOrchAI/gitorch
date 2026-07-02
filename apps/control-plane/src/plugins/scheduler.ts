import fp from 'fastify-plugin'
import { FastifyInstance } from 'fastify'
import {
  AgentOrchestrator,
  RuntimeRegistry,
  createCliRuntimeAdapter,
  type F6AgentRole,
} from '@gitorch/agents'

export interface SchedulerOptions {
  // Empty options type
}

const schedulerPlugin = fp<SchedulerOptions>(async (app: FastifyInstance) => {
  // Initialize Orchestrator Registry
  const registry = new RuntimeRegistry()

  // Register real CLI adapters running hermes binary
  registry.register(
    createCliRuntimeAdapter({
      runtime: 'antigravity',
      binary: '/home/ubuntu/.local/bin/hermes',
      args: ['--oneshot'],
    })
  )

  registry.register(
    createCliRuntimeAdapter({
      runtime: 'codex',
      binary: '/home/ubuntu/.local/bin/hermes',
      args: ['--oneshot', '--provider', 'openai'],
    })
  )

  const orchestrator = new AgentOrchestrator({
    registry,
  })

  const triggerAgentMission = async (role: F6AgentRole) => {
    app.log.info(`[Scheduler] Triggering agent mission for role: ${role}`)
    try {
      // Find the active project
      const project = await app.prisma.project.findFirst({
        where: { isActive: true },
      })

      if (!project) {
        app.log.warn('[Scheduler] No active project found to trigger mission')
        return
      }

      // Create mission in DB
      const mission = await app.prisma.mission.create({
        data: {
          projectId: project.id,
          type: `agent-run-${role}`,
          status: 'pending',
          payload: {
            role,
            triggeredBy: 'scheduler',
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
            credentialRef: {
              connectionId: `conn-${role}-${Date.now()}`,
              ownerScope: 'project',
              runtime: role === 'po' ? 'codex' : 'antigravity',
              providedSecrets: [],
            },
            userId: 'scheduler-user',
          })

          await app.prisma.mission.update({
            where: { id: mission.id },
            data: {
              status: result.exitCode === 0 ? 'completed' : 'blocked',
              completedAt: new Date(),
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
        .catch((err) => {
          app.log.error(err, `[Scheduler] Failed to execute mission ${mission.id}`)
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
})

export default schedulerPlugin
export { schedulerPlugin }
