import fp from 'fastify-plugin'
import { FastifyInstance } from 'fastify'
import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CronExpressionParser } from 'cron-parser'
import {
  resolveRuntimeChain,
  isFailoverError,
  type ResolverDefaults,
} from '../lib/runtime-resolver.js'
import {
  AgentOrchestrator,
  RuntimeRegistry,
  createCliRuntimeAdapter,
  createPodmanCommandRunner,
  createPythonSdkRuntimeAdapter,
  isF6AgentRole,
  DEFAULT_AGENT_RUNTIME_ASSIGNMENTS,
  type F6AgentRole,
  type F6AgentRuntime,
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

// Padrões da instância para o resolvedor por projeto: motor por papel (config
// do pacote de agentes) e modelo por papel. O projeto sobrescreve via
// project.runtimeConfig.agents.
const RESOLVER_DEFAULTS: ResolverDefaults = {
  runtimeByRole: {
    po: DEFAULT_AGENT_RUNTIME_ASSIGNMENTS.po.runtime,
    ra: DEFAULT_AGENT_RUNTIME_ASSIGNMENTS.ra.runtime,
    sm: DEFAULT_AGENT_RUNTIME_ASSIGNMENTS.sm.runtime,
    qa: DEFAULT_AGENT_RUNTIME_ASSIGNMENTS.qa.runtime,
  },
  modelByRole: MODEL_BY_ROLE,
}

/**
 * Uma agenda está "vencida" quando a última ocorrência do cron até `now` é
 * posterior ao último disparo registrado. Puro e testável.
 */
export function isScheduleDue(cron: string, lastTriggeredAt: Date | null, now: Date): boolean {
  const expression = CronExpressionParser.parse(cron, { currentDate: now, tz: 'UTC' })
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
  const engine = process.env['GITORCH_CONTAINER_ENGINE'] ?? 'podman'
  const stagingBase = process.env['GITORCH_MISSION_CRED_DIR'] ?? '/var/lib/gitorch/mission-creds'
  app.log.info(`[Scheduler] Missões em container: engine=${engine} image=${image}`)

  // Varredura no boot: um crash entre materializar e limpar deixaria credencial
  // descriptografada no disco. No boot não há missão ativa, então tudo em
  // stagingBase é órfão e é removido. O diretório nasce 0700.
  void fs
    .rm(stagingBase, { recursive: true, force: true })
    .then(() => fs.mkdir(stagingBase, { recursive: true, mode: 0o700 }))
    .catch((err) => app.log.warn(err, '[Scheduler] falha ao limpar staging de credenciais no boot'))

  // Credencial POR MISSÃO: materializa a credencial do dono do projeto (da sua
  // EngineConnection cifrada) num staging temporário, monta SOMENTE-LEITURA em
  // /run/gitorch-credentials, e o entrypoint da imagem a copia para o HOME
  // gravável. O staging é apagado ao fim. Assim a missão de um cliente nunca vê
  // a credencial de outro nem a do host.
  const prepareMounts = async (request: {
    env: Record<string, string>
  }): Promise<{
    mounts: Array<{ source: string; target: string; readOnly?: boolean }>
    cleanup?: () => Promise<void>
  }> => {
    const runtime = request.env['GITORCH_RUNTIME']
    const ownerUserId = request.env['GITORCH_OWNER_USER_ID']
    if (!runtime || !ownerUserId) return { mounts: [] }

    // 0700: staging guarda a credencial descriptografada em host compartilhado.
    const dir = path.join(stagingBase, randomUUID())
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const cleanup = async () => {
      await fs.rm(dir, { recursive: true, force: true })
    }
    try {
      const ok = await app.engineConnections.materializeToHome(ownerUserId, runtime, dir)
      if (!ok) {
        await cleanup()
        app.log.warn(
          `[Scheduler] Sem credencial conectada de ${runtime} para o usuário ${ownerUserId}; missão sem credencial`
        )
        return { mounts: [] }
      }
      return {
        mounts: [{ source: dir, target: '/run/gitorch-credentials', readOnly: true }],
        cleanup,
      }
    } catch (err) {
      await cleanup()
      // Falha de DESCRIPTOGRAFIA é incidente (chave trocada/dado corrompido): NÃO
      // mascarar rodando sem credencial — propaga para a missão falhar com causa
      // clara. Outras falhas (fs) são best-effort e não derrubam a preparação.
      if ((err as { name?: string })?.name === 'CredentialDecryptError') {
        throw err
      }
      app.log.error(err, '[Scheduler] falha ao materializar credencial da missão')
      return { mounts: [] }
    }
  }

  return createPodmanCommandRunner({
    image,
    podmanBinary: engine,
    userNamespace: engine === 'docker' ? false : 'keep-id',
    memoryLimit: process.env['GITORCH_MISSION_MEMORY'] ?? '2g',
    prepareMounts,
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
    // --print: não-interativo. --sandbox: ADICIONA restrições de terminal e faz
    // os hooks do plugin GitOrch (gate de shell/leitura, convergência) rodarem.
    // --print-timeout limita a espera pela resposta do modelo.
    //
    // CRÍTICO (QA real 2026-07-04): o agy lê a MISSÃO do STDIN. Entregar o prompt
    // como argumento posicional com o stdin vazio faz o motor "fixar" nas
    // próprias flags de CLI (--sandbox/--print-timeout) como se fossem a tarefa —
    // ele escrevia "Relatório de Verificação de Sandbox" em vez do deliverable.
    // Com o prompt via stdin (promptViaStdin) ele foca e entrega o brief correto.
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
        promptViaStdin: true,
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

    // Cadeia de motores escolhida pela config do projeto (por agente), com queda
    // para o padrão da instância. Nada de motor hardcoded; a cadeia é a base do
    // failover (tenta o próximo motor do cliente se o primeiro esgotar cota/errar).
    const chain = resolveRuntimeChain(role, project.runtimeConfig, RESOLVER_DEFAULTS)
    const primary = chain[0] as { runtime: string; model?: string }

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
          runtime: primary.runtime,
          model: primary.model ?? MODEL_BY_ROLE[role],
        },
      },
    })

    app.log.info(
      `[Scheduler] Mission created in DB: ${mission.id} for role ${role} (chain=${chain
        .map((c) => c.runtime)
        .join('>')})`
    )

    // Executa em background com failover; o disparo retorna assim que registrada.
    void executeMissionWithFailover(mission.id, project, role, chain)

    return { triggered: true, missionId: mission.id }
  }

  type ChainProject = { id: string; wingId: string; name: string; userId: string | null }

  // Tenta a cadeia de motores em ordem; sucesso encerra; erro de cota/auth cai
  // para o próximo; erro real encerra em failed. Nunca mascara: o estado final
  // é sempre gravado (completed com o motor que deu certo, ou failed com o erro).
  const executeMissionWithFailover = async (
    missionId: string,
    project: ChainProject,
    role: F6AgentRole,
    chain: Array<{ runtime: string; model?: string }>
  ): Promise<void> => {
    let lastError = 'nenhum motor executou'
    for (let i = 0; i < chain.length; i++) {
      const sel = chain[i] as { runtime: string; model?: string }
      const model = sel.model ?? MODEL_BY_ROLE[role]
      const isLast = i === chain.length - 1

      // Reinicia o relógio de "presa" a cada tentativa: o limite de stale é por
      // tentativa (igual ao timeoutMs), não pela soma da cadeia. Sem isto, a
      // varredura de stale marcaria a missão failed no meio do failover e um
      // sucesso posterior seria descartado (write condicional em status running).
      await app.prisma.mission
        .updateMany({
          where: { id: missionId, status: 'running' },
          data: { startedAt: new Date() },
        })
        .catch(() => undefined)

      try {
        const result = await orchestrator.runMission({
          id: missionId,
          projectId: project.id,
          repository: project.wingId,
          role,
          goal: `Analyze and coordinate tasks for ${project.name}`,
          context: [],
          runtime: { runtime: sel.runtime as F6AgentRuntime, model },
          credentialRef: {
            connectionId: `conn-${role}-${missionId}-${sel.runtime}`,
            ownerScope: 'project',
            runtime: sel.runtime as F6AgentRuntime,
            providedSecrets: [],
            ...(project.userId ? { ownerUserId: project.userId } : {}),
          },
          userId: project.userId ?? 'scheduler-user',
          timeoutMs: STALE_RUNNING_MS,
        })

        if (result.exitCode === 0 && result.output.trim().length > 0) {
          const updated = await app.prisma.mission.updateMany({
            where: { id: missionId, status: 'running' },
            data: {
              status: 'completed',
              completedAt: new Date(),
              error: null,
              result: { output: result.output, stderr: result.stderr, runtime: sel.runtime },
            },
          })
          if (updated.count === 0) {
            app.log.warn(`[Scheduler] Mission ${missionId} já não estava 'running'; descartado`)
            return
          }
          app.log.info(`[Scheduler] Mission ${missionId} completed via ${sel.runtime}`)
          try {
            await app.saveMissionMemory({
              wingId: project.wingId,
              missionId,
              agentRole: role,
              content: result.output,
            })
          } catch (memErr) {
            app.log.error(memErr, `[Scheduler] Falha ao gravar memória de ${missionId}`)
          }
          return
        }

        lastError = result.stderr || `exit ${result.exitCode}`
        // exit 124 = timeout/hang do motor (o modo transitório mais comum);
        // também justifica trocar para o próximo motor do cliente.
        const worthy = isFailoverError(lastError) || result.exitCode === 124
        if (!isLast && worthy) {
          app.log.warn(
            `[Scheduler] ${sel.runtime} falhou (${result.exitCode}); failover para ${chain[i + 1]?.runtime}`
          )
          continue
        }
        break
      } catch (err) {
        lastError = String((err as { stack?: string })?.stack ?? err)
        // Simétrico com o caminho de exit != 0: só faz failover se o erro for do
        // tipo cota/rate/auth. Erro sistêmico (ex.: disco cheio, mismatch) falha
        // rápido em vez de repetir em todos os motores.
        if (!isLast && isFailoverError(lastError)) {
          app.log.warn(err, `[Scheduler] erro recuperável em ${sel.runtime}; próximo motor`)
          continue
        }
        break
      }
    }

    // Chegou aqui = nenhum motor concluiu. Grava falha honesta.
    try {
      await app.prisma.mission.updateMany({
        where: { id: missionId, status: 'running' },
        data: { status: 'failed', completedAt: new Date(), error: lastError.slice(0, 4000) },
      })
    } catch (persistErr) {
      app.log.error(persistErr, `[Scheduler] Falha ao persistir falha de ${missionId}`)
    }
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
