import fp from 'fastify-plugin'
import { FastifyInstance } from 'fastify'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CronExpressionParser } from 'cron-parser'
import {
  AgentOrchestrator,
  RuntimeRegistry,
  createCliRuntimeAdapter,
  createPodmanCommandRunner,
  createPythonSdkRuntimeAdapter,
  isF6AgentRole,
  type F6AgentRole,
  type RuntimeCommandRunner,
  type WorkspaceProvider,
} from '@gitorch/agents'
import { LocalWorkspaceProvider, WorkspaceManager } from '@gitorch/workspace-engine'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// dist/plugins -> raiz do repo -> runtime/
const runtimeScriptPath = path.resolve(__dirname, '../../../../runtime/run_antigravity_sdk.py')

export interface SchedulerOptions {
  // Empty options type
}

// Guardas operacionais: orçamento diário de missões e proteção de memória do host.
const MAX_MISSIONS_PER_DAY = Number(process.env['GITORCH_MAX_MISSIONS_PER_DAY'] ?? '4')
const STALE_RUNNING_MS = Number(
  process.env['GITORCH_STALE_RUNNING_MS'] ?? String(2 * 60 * 60 * 1000)
)
// Missão que fica 'pending' além disso (processo morto antes de iniciar) vira failed.
const PENDING_TIMEOUT_MS = Number(
  process.env['GITORCH_PENDING_TIMEOUT_MS'] ?? String(10 * 60 * 1000)
)

interface TriggerResult {
  triggered: boolean
  missionId?: string
  reason?: string
}
// Nomes de modelo aceitos pelo Antigravity CLI (ver `agy models`); configuráveis por ambiente.
const MODEL_FLASH = process.env['GITORCH_MODEL_FLASH'] ?? 'Gemini 3.5 Flash (Medium)'
const MODEL_PRO = process.env['GITORCH_MODEL_PRO'] ?? 'Gemini 3.1 Pro (Low)'

// PO decide (modelo forte); RA/SM/QA analisam (modelo rápido).
const MODEL_BY_ROLE: Record<F6AgentRole, string> = {
  po: MODEL_PRO,
  ra: MODEL_FLASH,
  sm: MODEL_FLASH,
  qa: MODEL_FLASH,
}

/**
 * Uma agenda está "vencida" quando a última ocorrência do cron até `now` é
 * posterior ao último disparo registrado. Puro e testável.
 */
export function isScheduleDue(cron: string, lastTriggeredAt: Date | null, now: Date): boolean {
  const expression = CronExpressionParser.parse(cron, { currentDate: now })
  const previousOccurrence = expression.prev().toDate()
  if (previousOccurrence > now) return false
  return lastTriggeredAt === null || previousOccurrence > lastTriggeredAt
}

function buildWorkspaceProvider(app: FastifyInstance): WorkspaceProvider {
  const executor = process.env['GITORCH_EXECUTOR'] ?? 'local-process'
  if (executor === 'firecracker') {
    app.log.info('[Scheduler] Executor: firecracker (MicroVM por tenant)')
    return new WorkspaceManager()
  }
  if (executor === 'podman') {
    app.log.info('[Scheduler] Executor: podman (container descartável por missão)')
    return new LocalWorkspaceProvider()
  }
  // Default para hosts sem /dev/kvm, onde MicroVM (Firecracker) não é viável.
  app.log.info('[Scheduler] Executor: local-process (sem MicroVM; single-tenant)')
  return new LocalWorkspaceProvider()
}

/**
 * Runner das missões conforme o executor. No modo podman, cada missão roda em
 * container descartável: enxerga só o workspace e as credenciais montadas —
 * nunca o .env do control plane ou o sistema de arquivos do host.
 */
function buildMissionRunner(app: FastifyInstance): RuntimeCommandRunner | undefined {
  const executor = process.env['GITORCH_EXECUTOR'] ?? 'local-process'
  if (executor !== 'podman') return undefined

  const image = process.env['GITORCH_AGENT_IMAGE'] ?? 'localhost/gitorch-agent:latest'
  const home = process.env['HOME'] ?? '/root'
  const engine = process.env['GITORCH_CONTAINER_ENGINE'] ?? 'podman'
  app.log.info(`[Scheduler] Missões em container: engine=${engine} image=${image}`)

  // Credenciais OAuth dos motores, montadas SOMENTE-LEITURA em um staging
  // (/run/gitorch-credentials); o entrypoint da imagem as COPIA para o HOME
  // gravável, então o original no host nunca é alterado e o CLI ainda pode
  // escrever seus arquivos de apoio. Só monta o que existe no host (origem
  // inexistente derrubaria o start do container). Fase 2: estas credenciais
  // passam a ser resolvidas por EngineConnection do dono do projeto.
  const credentialDirs = [
    { source: `${home}/.gemini`, target: '/run/gitorch-credentials/.gemini' },
    { source: `${home}/.codex`, target: '/run/gitorch-credentials/.codex' },
  ]
  const mounts = credentialDirs
    .filter((dir) => existsSync(dir.source))
    .map((dir) => ({ ...dir, readOnly: true }))

  return createPodmanCommandRunner({
    image,
    podmanBinary: engine,
    userNamespace: engine === 'docker' ? false : 'keep-id',
    memoryLimit: process.env['GITORCH_MISSION_MEMORY'] ?? '2g',
    mounts,
  })
}

const schedulerPlugin = fp<SchedulerOptions>(async (app: FastifyInstance) => {
  const registry = new RuntimeRegistry()
  const missionRunner = buildMissionRunner(app)
  const containerized = missionRunner !== undefined

  // Motor principal: Antigravity CLI. Política do projeto: runtimes de agente
  // autenticam por OAuth (nunca por chave de API embutida no ambiente).
  // GITORCH_ANTIGRAVITY_MODE=api mantém a ponte REST apenas para diagnóstico.
  if (process.env['GITORCH_ANTIGRAVITY_MODE'] === 'api') {
    registry.register(
      createPythonSdkRuntimeAdapter({
        runtime: 'antigravity',
        scriptPath: runtimeScriptPath,
      })
    )
  } else {
    // --print: não-interativo. --sandbox: ADICIONA restrições de terminal e
    // auto-aprova ferramentas DENTRO do sandbox (o oposto de
    // --dangerously-skip-permissions, que desliga aprovações). Sem --sandbox o
    // modo --print bloqueia no primeiro uso de ferramenta esperando aprovação
    // sem TTY. --print-timeout limita a espera pela resposta do modelo.
    const agyExtraArgs = (process.env['GITORCH_AGY_EXTRA_ARGS'] ?? '').split(' ').filter(Boolean)
    const printTimeout = process.env['GITORCH_AGY_PRINT_TIMEOUT'] ?? '20m'
    registry.register(
      createCliRuntimeAdapter({
        runtime: 'antigravity',
        // Em container o binário vem da imagem; no host, do PATH/config.
        binary: containerized ? 'agy' : (process.env['GITORCH_AGY_BIN'] ?? 'agy'),
        args: ['--print', '--sandbox', '--print-timeout', printTimeout, ...agyExtraArgs],
        modelArgName: '--model',
        workspaceDirArgName: '--add-dir',
        ...(missionRunner ? { runner: missionRunner } : {}),
      })
    )
  }

  // Motor secundário: Codex CLI (OAuth). Sandbox só-leitura auto-executa
  // ferramentas de leitura sem TTY; --skip-git-repo-check dispensa a exigência
  // de repo git no cwd. O diretório da missão chega pelo cwd do runner.
  registry.register(
    createCliRuntimeAdapter({
      runtime: 'codex',
      binary: 'codex',
      args: ['exec', '-s', 'read-only', '--skip-git-repo-check'],
      ...(missionRunner ? { runner: missionRunner } : {}),
    })
  )

  const orchestrator = new AgentOrchestrator({
    registry,
    workspace: buildWorkspaceProvider(app),
  })

  // Missão presa vira failed: cobre 'running' passado de STALE_RUNNING_MS e
  // 'pending' que nunca chegou a rodar (processo morto entre criar e iniciar).
  const failStuckMissions = async (): Promise<void> => {
    const staleBefore = new Date(Date.now() - STALE_RUNNING_MS)
    const pendingBefore = new Date(Date.now() - PENDING_TIMEOUT_MS)
    const stuck = await app.prisma.mission.updateMany({
      where: {
        OR: [
          { status: 'running', startedAt: { lt: staleBefore } },
          { status: 'pending', createdAt: { lt: pendingBefore } },
        ],
      },
      data: {
        status: 'failed',
        error: `Mission stuck: presa em running/pending além do limite sem concluir`,
        completedAt: new Date(),
      },
    })
    if (stuck.count > 0) {
      app.log.warn(`[Scheduler] ${stuck.count} missão(ões) travadas marcadas como failed`)
    }
  }

  // Serializa disparos no processo: elimina a corrida entre a checagem de
  // concorrência e a criação da missão (dois POST simultâneos criariam duas).
  let triggerChain: Promise<TriggerResult> = Promise.resolve({ triggered: false, reason: 'init' })

  const runTrigger = async (role: F6AgentRole, projectId?: string): Promise<TriggerResult> => {
    await failStuckMissions()

    // Concorrência 1: uma missão ativa (pending OU running) por vez.
    const active = await app.prisma.mission.count({
      where: { status: { in: ['pending', 'running'] } },
    })
    if (active > 0) {
      app.log.warn(`[Scheduler] Missão em andamento; pulando janela de ${role}`)
      return { triggered: false, reason: 'busy' }
    }

    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)

    // Failsafe da instância (não por tenant): teto global de missões/dia para
    // proteger a VM inteira. O limite por tenant é o do plano (abaixo).
    const instanceToday = await app.prisma.mission.count({
      where: { createdAt: { gte: startOfDay } },
    })
    if (instanceToday >= MAX_MISSIONS_PER_DAY) {
      app.log.warn(
        `[Scheduler] Failsafe da instância atingido (${instanceToday}/${MAX_MISSIONS_PER_DAY}); pulando ${role}`
      )
      return { triggered: false, reason: 'instance-failsafe' }
    }

    const project = projectId
      ? await app.prisma.project.findFirst({
          where: { id: projectId, isActive: true },
          include: { user: { include: { plan: true } } },
        })
      : await app.prisma.project.findFirst({
          where: { isActive: true },
          include: { user: { include: { plan: true } } },
        })
    if (!project) {
      app.log.warn('[Scheduler] No active project found to trigger mission')
      return { triggered: false, reason: 'no-project' }
    }

    // Orçamento do plano: total de missões do dia somando TODOS os projetos do
    // dono (o limite do plano é por usuário, não por projeto).
    const plan = project.user?.plan
    if (project.userId && plan) {
      const ownerToday = await app.prisma.mission.count({
        where: {
          createdAt: { gte: startOfDay },
          project: { userId: project.userId },
        },
      })
      if (ownerToday >= plan.maxMissionsPerDay) {
        app.log.warn(
          `[Scheduler] Orçamento do plano ${plan.id} atingido para o usuário ${project.userId} (${ownerToday}/${plan.maxMissionsPerDay}); pulando`
        )
        return { triggered: false, reason: 'plan-budget' }
      }
    }

    // Criação atômica já em 'running': fecha a janela de corrida do guard e
    // garante que a missão sempre tem startedAt (varredura de stale a alcança).
    const mission = await app.prisma.mission.create({
      data: {
        projectId: project.id,
        type: `agent-run-${role}`,
        status: 'running',
        startedAt: new Date(),
        payload: {
          role,
          triggeredBy: 'scheduler',
          runtime: 'antigravity',
          model: MODEL_BY_ROLE[role],
        },
      },
    })

    app.log.info(`[Scheduler] Mission created in DB: ${mission.id} for role ${role}`)

    // Executa em background; o disparo retorna assim que a missão está registrada.
    void orchestrator
      .runMission({
        id: mission.id,
        projectId: project.id,
        repository: project.wingId, // formato owner/repo do GitHub
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
        timeoutMs: STALE_RUNNING_MS,
      })
      .then(async (result) => {
        // Escrita condicional: só grava se a missão ainda está 'running'. Se a
        // varredura de stale já a marcou 'failed', não sobrescrevemos com sucesso.
        const updated = await app.prisma.mission.updateMany({
          where: { id: mission.id, status: 'running' },
          data: {
            status: result.exitCode === 0 ? 'completed' : 'failed',
            completedAt: new Date(),
            error: result.exitCode === 0 ? null : result.stderr.slice(0, 4000),
            result: { output: result.output, stderr: result.stderr },
          },
        })
        if (updated.count === 0) {
          app.log.warn(
            `[Scheduler] Mission ${mission.id} já não estava 'running' ao concluir (exit ${result.exitCode}); resultado descartado`
          )
        } else {
          app.log.info(
            `[Scheduler] Mission completed: ${mission.id} with exitCode: ${result.exitCode}`
          )
          // Sucesso vira memória de longo prazo do PROJETO (isolada por wingId).
          // Falha na gravação de memória não reverte a missão — mas nunca é silenciosa.
          if (result.exitCode === 0 && result.output.trim().length > 0) {
            try {
              await app.saveMissionMemory({
                wingId: project.wingId,
                missionId: mission.id,
                agentRole: role,
                content: result.output,
              })
            } catch (memErr) {
              app.log.error(memErr, `[Scheduler] Falha ao gravar memória da missão ${mission.id}`)
            }
          }
        }
      })
      .catch(async (err) => {
        app.log.error(err, `[Scheduler] Failed to execute mission ${mission.id}`)
        // Nunca mascarar: falha vira status failed com erro legível no banco.
        try {
          await app.prisma.mission.updateMany({
            where: { id: mission.id, status: 'running' },
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

    return { triggered: true, missionId: mission.id }
  }

  const triggerAgentMission = async (
    role: F6AgentRole,
    projectId?: string
  ): Promise<TriggerResult> => {
    app.log.info(`[Scheduler] Triggering agent mission for role: ${role}`)
    // Encadeia os disparos para que nunca rodem concorrentes (guard sem corrida).
    const result = triggerChain.then(
      () => runTrigger(role, projectId),
      () => runTrigger(role, projectId)
    )
    triggerChain = result.catch(() => ({ triggered: false, reason: 'error' }))
    try {
      return await result
    } catch (err) {
      app.log.error(err, `[Scheduler] Error triggering agent mission for role ${role}`)
      return { triggered: false, reason: 'error' }
    }
  }

  // Reasons de recusa que são temporárias: a janela deve ser reprocessada no
  // próximo tick (o claim do lastTriggeredAt é revertido). 'no-project' e cron
  // inválido não entram aqui — não adianta reprocessar.
  const RETRYABLE_REASONS: ReadonlySet<string> = new Set([
    'busy',
    'plan-budget',
    'instance-failsafe',
    'error',
    'init',
  ])

  // Agenda dirigida a dados: cada projeto define seu cron por agente em
  // project_schedules. A cada minuto, dispara o que venceu desde o último
  // disparo registrado. O claim condicional do lastTriggeredAt impede dois
  // ticks de dispararem a mesma janela; quando o disparo é recusado por um
  // motivo temporário (missão em andamento, orçamento), o claim é revertido
  // para a janela não se perder.
  const tick = async () => {
    const now = new Date()
    let schedules
    try {
      schedules = await app.prisma.projectSchedule.findMany({
        where: { isActive: true, project: { isActive: true } },
      })
    } catch (err) {
      // Nunca deixar o tick rejeitar: um erro de banco não pode derrubar o
      // processo (setInterval não trata a promise).
      app.log.error(err, '[Scheduler] tick falhou ao ler agendas; tentando no próximo minuto')
      return
    }

    for (const schedule of schedules) {
      if (!isF6AgentRole(schedule.agentRole)) {
        app.log.warn(
          `[Scheduler] Agenda ${schedule.id} com papel desconhecido '${schedule.agentRole}'; ignorando`
        )
        continue
      }

      let due = false
      try {
        due = isScheduleDue(schedule.cron, schedule.lastTriggeredAt, now)
      } catch (err) {
        app.log.warn(
          `[Scheduler] Agenda ${schedule.id} com cron inválido '${schedule.cron}': ${String(err)}`
        )
        continue
      }
      if (!due) continue

      try {
        const claimed = await app.prisma.projectSchedule.updateMany({
          where: { id: schedule.id, lastTriggeredAt: schedule.lastTriggeredAt },
          data: { lastTriggeredAt: now },
        })
        if (claimed.count === 0) continue // outro tick já reivindicou esta janela

        const result = await triggerAgentMission(schedule.agentRole, schedule.projectId)

        // Recusa temporária: devolve a janela (reverte o claim) para reprocessar.
        if (!result.triggered && result.reason && RETRYABLE_REASONS.has(result.reason)) {
          await app.prisma.projectSchedule.updateMany({
            where: { id: schedule.id, lastTriggeredAt: now },
            data: { lastTriggeredAt: schedule.lastTriggeredAt },
          })
        }
      } catch (err) {
        app.log.error(err, `[Scheduler] falha ao processar agenda ${schedule.id}`)
      }
    }
  }

  // Loop de verificação a cada minuto. Não roda sob teste para não vazar timer
  // nem disparar missão real contra o Prisma de teste (paridade com under-pressure).
  // A execução é envolvida para nunca propagar rejeição (o processo não cai).
  const intervalId =
    process.env['NODE_ENV'] === 'test'
      ? undefined
      : setInterval(() => {
          void tick().catch((err) => app.log.error(err, '[Scheduler] tick rejeitou'))
        }, 60 * 1000)

  // Clean up interval on app close
  app.addHook('onClose', async () => {
    if (intervalId) {
      clearInterval(intervalId)
    }
  })

  // Exposto para rotas administrativas e QA real dispararem missões sob demanda.
  app.decorate('triggerAgentMission', triggerAgentMission)
})

declare module 'fastify' {
  interface FastifyInstance {
    triggerAgentMission: (role: F6AgentRole, projectId?: string) => Promise<TriggerResult>
  }
}

export default schedulerPlugin
export { schedulerPlugin }
