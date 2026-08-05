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
  realRuntimeCommandRunner,
  DEFAULT_AGENT_RUNTIME_ASSIGNMENTS,
  type F6AgentRole,
  type F6AgentRuntime,
  type RuntimeCommandRunner,
  type WorkspaceProvider,
} from '@gitorch/agents'
import type { EngineConnectionService } from '../services/engine-connection.js'
import {
  LocalWorkspaceProvider,
  WorkspaceManager,
  RemoteWorkspaceProvider,
} from '@gitorch/workspace-engine'
import { createSshCommandRunner } from '@gitorch/agents'
import { buildMissionEnricher, persistMissionMemory } from '../services/mission-context.js'
import { assertMissionDelivered } from '../services/mission-outcome.js'
import { ClientEnvironmentService } from '../services/environment.js'
import { runPoMissionViaRails } from '../services/po-rails-mission.js'
import { runRaMissionViaRails } from '../services/ra-rails-mission.js'
import { runQaMissionViaRails } from '../services/qa-rails-mission.js'
import { runSmDelegation } from '../services/sm-delegation.js'
import { runSmWatchdog, buildTelegramNotifier } from '../services/sm-watchdog.js'
import { resolveNotifyChatId } from '../services/telegram-link.js'
import { runIncidentSensor } from '../services/incident-sensor.js'
import { mintInstallationToken } from '../services/github-app-token.js'
import {
  resolveBoardColumns,
  resolveSprintDays,
  createCardMover,
} from '../services/board-status.js'
import {
  ensureProjectBoard,
  resolveGithubOwnerId,
  type ResolvedOwner,
} from '../services/onboarding-board.js'
import { ProjectV2Client } from '@gitorch/github-sync'
import { RailsStepError } from '../services/rails-runner.js'
import { GithubExecutionError } from '../services/github-backlog.js'
import { canRunMission, shouldAlertForQuota } from '../lib/spend-guard.js'
import { computeConsumption } from '../lib/consumption.js'
import { pipelineCheckEnabled } from '../config/pipeline-check.js'
import { resolveMissionCpus } from '../config/mission-cpus.js'
import { reapOrphanContainers, failOrphanRunningMissions, type ReapResult } from './boot-reaper.js'
import type { PrismaClient } from '@prisma/client'
import * as os from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// dist/plugins -> raiz do repo -> runtime/
const runtimeScriptPath = path.resolve(__dirname, '../../../../runtime/run_antigravity_sdk.py')

export interface SchedulerOptions {
  // Empty options type
}

// Guardas operacionais: orçamento diário de missões e proteção de memória do host.
const MAX_MISSIONS_PER_DAY = Number(process.env['GITORCH_MAX_MISSIONS_PER_DAY'] ?? '4')
// Teto de missões simultâneas na VM — cobre cadência E o wizard
// (processSetupMissions). Default 1 (seguro pra qualquer install não
// configurada); a VM dev atual (ARM 4CPU/11GB) roda com
// GITORCH_MAX_CONCURRENT=2 (ver .env.example), cada missão sob
// GITORCH_EXEC_LIMITS (execution-limits.ts); sobe mais na VM-MT-SaaS (32GB).
const MAX_CONCURRENT_MISSIONS = Number(process.env['GITORCH_MAX_CONCURRENT'] ?? '1')
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

/** Só o que a resolução do motor versionado lê do ambiente do cliente —
 *  permite injetar um fake nos testes sem tocar Prisma/disco reais, mesmo
 *  padrão de Pick<EngineConnectionService, 'materializeToHome'> acima. */
export type EnvironmentLookup = Pick<ClientEnvironmentService, 'current'>

export interface EngineBinResolution {
  /** Diretório do motor versionado do ambiente (prepend no PATH da execução). */
  dir?: string
  /** Motivo de ter caído no host — SEMPRE presente quando `dir` está ausente. */
  fallbackReason?: string
}

async function defaultBinDirExists(dir: string): Promise<boolean> {
  return fs
    .stat(dir)
    .then((s) => s.isDirectory())
    .catch(() => false)
}

/**
 * Resolve `<env>/.gitorch/engines/<runtime>/bin` do AMBIENTE DO CLIENTE — não
 * o binário genérico do host. O bootstrap (W1.2) instala os motores nas
 * versões do manifesto ali dentro e só grava `resourcesLock` no banco quando
 * termina com sucesso (ClientEnvironmentService.bootstrapResources).
 *
 * Fallback SEMPRE explicado (o motivo vai em `fallbackReason`, nunca
 * silencioso): sem ambiente para o usuário, ambiente sem resourcesLock
 * (bootstrap não rodou ou falhou), ou o bin do motor específico não existe em
 * disco (ex.: manifesto não lista aquele runtime, ou o diretório foi
 * removido) — em qualquer um desses casos a missão roda com o binário do
 * host, o comportamento de sempre.
 */
export async function resolveEngineBinDir(
  ownerUserId: string,
  runtime: string,
  environments: EnvironmentLookup,
  pathExists: (dir: string) => Promise<boolean> = defaultBinDirExists
): Promise<EngineBinResolution> {
  const env = await environments.current(ownerUserId)
  if (!env) {
    return { fallbackReason: `usuário ${ownerUserId} sem ambiente provisionado` }
  }
  if (!env.resourcesLock) {
    return {
      fallbackReason: `ambiente ${env.id} (status=${env.status}) sem resourcesLock — bootstrap não rodou ou falhou`,
    }
  }
  const dir = path.join(env.path, '.gitorch', 'engines', runtime, 'bin')
  const exists = await pathExists(dir)
  if (!exists) {
    return { fallbackReason: `bin do motor '${runtime}' não encontrado em ${dir}` }
  }
  return { dir }
}

/**
 * Runner do executor local-process (sem container): materializa a credencial
 * conectada do dono num HOME temporário e a expõe ao processo filho — sem
 * isto, um motor conectado via token colado (ex.: Claude) nunca chegava à
 * missão fora do podman, porque só o entrypoint da imagem exportava
 * `.gitorch/env/*` como variável de ambiente (o local-process não tem
 * entrypoint nenhum). Sem GITORCH_RUNTIME/GITORCH_OWNER_USER_ID no pedido, ou
 * sem conexão do motor, roda inalterado (fallback pras credenciais ambiente
 * do host, comportamento de sempre em modo single-tenant).
 *
 * `environments` (W1.3.1, opcional/injetável) resolve o motor VERSIONADO do
 * ambiente do cliente e o antepõe no PATH da execução — sem ele (ou sem os
 * recursos instalados), cai no binário do host com log claro (`log`).
 */
export function createLocalCredentialRunner(
  engineConnections: Pick<EngineConnectionService, 'materializeToHome'>,
  innerRunner: RuntimeCommandRunner = realRuntimeCommandRunner,
  environments?: EnvironmentLookup,
  log?: { info: (msg: string) => void; warn: (msg: string) => void }
): RuntimeCommandRunner {
  return async (request) => {
    const runtime = request.env['GITORCH_RUNTIME']
    const ownerUserId = request.env['GITORCH_OWNER_USER_ID']
    if (!runtime || !ownerUserId) return innerRunner(request)

    const dir = path.join(os.tmpdir(), `gitorch-local-cred-${randomUUID()}`)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    try {
      const ok = await engineConnections.materializeToHome(ownerUserId, runtime, dir)
      if (!ok) return await innerRunner(request)

      // Espelha o loop genérico do entrypoint.sh (infra/agent-image/ no repo
      // privado de infra, movido de scripts/infra/agent-image/ na task t8):
      // qualquer arquivo em .gitorch/env/* vira variável de ambiente do
      // processo filho — aqui é o único lugar que faz isso fora do container.
      const envDir = path.join(dir, '.gitorch', 'env')
      const envAdditions: Record<string, string> = { HOME: dir }
      const envFiles = await fs.readdir(envDir).catch(() => [] as string[])
      for (const name of envFiles) {
        envAdditions[name] = (await fs.readFile(path.join(envDir, name), 'utf8')).trim()
      }

      // Motor VERSIONADO do ambiente do cliente (W1.3.1): se o bootstrap já
      // instalou o runtime ali dentro, o processo filho o acha ANTES do
      // binário genérico do host (prepend no PATH) — sem isto a missão
      // sempre rodava o `agy`/`codex`/`claude` do host, ignorando o
      // isolamento por versão que o wizard prometeu. Fallback (sem
      // ambiente/resourcesLock/bin) preserva o comportamento de hoje, mas
      // nunca em silêncio.
      if (environments) {
        const resolution = await resolveEngineBinDir(ownerUserId, runtime, environments)
        if (resolution.dir) {
          const hostPath = request.env['PATH'] ?? process.env['PATH'] ?? ''
          envAdditions['PATH'] = `${resolution.dir}:${hostPath}`
          log?.info(
            `[Scheduler] Missão de ${ownerUserId} usa motor versionado do ambiente (${runtime}): ${resolution.dir}`
          )
        } else {
          log?.warn(
            `[Scheduler] Motor versionado indisponível para ${ownerUserId}/${runtime} — caindo pro binário do host (${resolution.fallbackReason})`
          )
        }
      }

      return await innerRunner({ ...request, env: { ...request.env, ...envAdditions } })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }
}

/**
 * Runner das missões conforme o executor. No modo podman, cada missão roda em
 * container descartável: enxerga só o workspace e as credenciais montadas —
 * nunca o .env do control plane ou o sistema de arquivos do host. No modo
 * local-process, credencial ainda é materializada (createLocalCredentialRunner)
 * — só o mecanismo de isolamento (container vs HOME temporário) muda.
 */
export function buildMissionRunner(
  app: FastifyInstance,
  environments: EnvironmentLookup
): RuntimeCommandRunner {
  const executor = process.env['GITORCH_EXECUTOR'] ?? 'local-process'
  if (executor !== 'podman') {
    return createLocalCredentialRunner(app.engineConnections, undefined, environments, app.log)
  }

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
      // As "mãos" no GitHub: se o dono conectou um token (runtime lógico
      // `github`), ele entra no MESMO staging e vira GH_TOKEN no container
      // (entrypoint). Ausência é normal — missão segue só-leitura de GitHub.
      await app.engineConnections.materializeToHome(ownerUserId, 'github', dir)
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

  const memoryLimit = process.env['GITORCH_MISSION_MEMORY'] ?? '2g'
  const missionCpus = resolveMissionCpus()
  return createPodmanCommandRunner({
    image,
    podmanBinary: engine,
    userNamespace: engine === 'docker' ? false : 'keep-id',
    memoryLimit,
    // Default = o próprio memoryLimit (zero swap adicional): provado ao vivo
    // que sem --memory-swap o podman deixa o container escapar até ~2x o
    // teto nominal (ver podman-runner.ts). Configurável separadamente só se
    // o operador quiser conceder folga de swap de propósito.
    memorySwapLimit: process.env['GITORCH_MISSION_MEMORY_SWAP'] ?? memoryLimit,
    // Teto de CPU (P2-4): fecha o caminho que faltava — memória já tinha teto,
    // CPU não tinha nenhum (ver podman-runner.ts).
    cpus: missionCpus,
    prepareMounts,
    // Decisão do dono (ver AGY_SKIP_PERMISSIONS_FLAG abaixo): nenhuma missão
    // roda sem confirmar que o plugin de segurança do GitOrch está na
    // imagem — --dangerously-skip-permissions fixa no código não pode ficar
    // sem trava se o plugin um dia deixar de ser instalado.
    requireGitorchPlugin: true,
  })
}

export interface RuntimeStack {
  registry: RuntimeRegistry
  orchestrator: AgentOrchestrator
  workspaceProvider: WorkspaceProvider
}

/** Fixa no código — ver o comentário no call site em buildRuntimeStack. */
const AGY_SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions'

/**
 * Monta os argumentos do Antigravity CLI. `--dangerously-skip-permissions`
 * sempre aparece, exatamente uma vez, mesmo que GITORCH_AGY_EXTRA_ARGS também
 * a declare (dedupe) — nunca depende só da env var, que pode não existir num
 * ambiente novo/recriado.
 */
export function buildAntigravityCliArgs(
  printTimeout: string,
  extraArgsEnv: string | undefined
): string[] {
  const extraArgs = (extraArgsEnv ?? '')
    .split(' ')
    .filter(Boolean)
    .filter((arg) => arg !== AGY_SKIP_PERMISSIONS_FLAG)
  return ['--sandbox', '--print-timeout', printTimeout, AGY_SKIP_PERMISSIONS_FLAG, ...extraArgs]
}

/**
 * Registra os adaptadores de motor (Antigravity + Codex) num registry NOVO e
 * monta o orchestrator em cima do workspace dado. Parametrizado por
 * missionRunner/workspaceProvider para poder existir em duas instâncias
 * independentes — uma local (produção paga, comportamento de sempre) e uma
 * remota (tier grátis, isolada na MT-SaaS) — sem duplicar a lógica de registro
 * dos motores.
 */
function buildRuntimeStack(
  app: FastifyInstance,
  missionRunner: RuntimeCommandRunner | undefined,
  workspaceProvider: WorkspaceProvider
): RuntimeStack {
  const registry = new RuntimeRegistry()
  // Nota: missionRunner agora é sempre definido (local-process também tem um
  // runner, via createLocalCredentialRunner) — "containerized" precisa checar
  // o executor de verdade, não mais a presença de um runner.
  const containerized = process.env['GITORCH_EXECUTOR'] === 'podman'

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
    // --sandbox: ADICIONA restrições de terminal e é o que faz os hooks do
    // plugin GitOrch (gate de shell/leitura, convergência) rodarem.
    // --dangerously-skip-permissions: FIXA NO CÓDIGO, não numa env var. Em modo
    // headless o motor não tem como perguntar "posso?" e auto-nega toda
    // ferramenta (o agente só narra intenções); o próprio binário instrui esta
    // flag ("Settings allow-rules do not apply"). Vivendo só numa env var, uma
    // reinstalação ou um .env recriado quebra a esteira inteira em silêncio —
    // por isso ela é obrigatória aqui. A segurança real continua sendo o gate
    // de hooks do GitOrch dentro do container, verificado ao vivo bloqueando
    // npm install e curl mesmo com a flag ligada (as duas negativas ficam no
    // log de auditoria).
    // --print <missão>: a missão é o VALOR de --print e vem POR ÚLTIMO. Medido
    // ao vivo contra a imagem real: stdin 0/3, argumento solto 0/1, assim 2/2.
    const printTimeout = process.env['GITORCH_AGY_PRINT_TIMEOUT'] ?? '20m'
    registry.register(
      createCliRuntimeAdapter({
        runtime: 'antigravity',
        // Em container o binário vem da imagem; no host, do PATH/config.
        binary: containerized ? 'agy' : (process.env['GITORCH_AGY_BIN'] ?? 'agy'),
        args: buildAntigravityCliArgs(printTimeout, process.env['GITORCH_AGY_EXTRA_ARGS']),
        modelArgName: '--model',
        workspaceDirArgName: '--add-dir',
        promptArgName: '--print',
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

  // Motor co-igual: Claude Code CLI (OAuth). A credencial já chega como env
  // CLAUDE_CODE_OAUTH_TOKEN (connectRawToken, credentialKind 'env') — sem este
  // adaptador de EXECUÇÃO o motor conectava mas nunca rodava ("No runtime
  // adapter registered for claude"), que é a fachada que o plano proíbe.
  // -p: modo não-interativo (print). --permission-mode plan: analisa sem
  // mutar, o equivalente ao read-only do Codex, e NÃO usamos
  // --dangerously-skip-permissions (o classificador de permissões bloqueia,
  // com razão). --model recebe o modelo da missão; o diretório vem pelo cwd
  // do runner, como no Codex. Flags confirmadas nos docs oficiais do CLI.
  registry.register(
    createCliRuntimeAdapter({
      runtime: 'claude',
      binary: containerized ? 'claude' : (process.env['GITORCH_CLAUDE_BIN'] ?? 'claude'),
      args: ['-p', '--permission-mode', 'plan'],
      modelArgName: '--model',
      ...(missionRunner ? { runner: missionRunner } : {}),
    })
  )

  const orchestrator = new AgentOrchestrator({
    registry,
    workspace: workspaceProvider,
    // Injeta conhecimento do projeto (codegraph + memórias do Cortex) no contexto.
    enrichContext: buildMissionEnricher({ cortex: app.cortex }),
  })

  return { registry, orchestrator, workspaceProvider }
}

/**
 * Stack REMOTO para missões de tier grátis: roda na MT-SaaS (VM de terceiro,
 * isolada) via SSH, nunca na nossa VM. Só existe se as variáveis do free-tier
 * estiverem configuradas — ausência delas é o caso comum hoje (a MT-SaaS não
 * está com o wiring de produção ligado) e `null` faz o dispatch cair no
 * stack local de sempre (ver selectRuntimeStack). Sem env → produção intacta.
 */
export function buildRemoteRuntimeStackIfConfigured(app: FastifyInstance): RuntimeStack | null {
  // .trim() antes do teste de vazio: nem todo mecanismo que seta env var
  // corta espaço (ex.: `export` de shell) — um valor só-espaço passaria no
  // teste falsy cru e tentaria um build remoto quebrado em vez de cair no
  // stack local (mesma convenção de config/mission-cpus.ts).
  const host = process.env['GITORCH_FREE_TIER_SSH_HOST']?.trim()
  const identityFile = process.env['GITORCH_FREE_TIER_SSH_KEY']?.trim()
  if (!host || !identityFile) return null

  app.log.info(`[Scheduler] Stack remoto do tier grátis configurado: ${host}`)

  // Um único runner SSH serve tanto o clone do workspace (sh -c direto no nó
  // remoto) quanto o `podman run` da missão (composto como hostRunner) — o
  // mesmo destino, a mesma chave, sem duplicar a lógica de conexão.
  const sshRunner = createSshCommandRunner({ host, identityFile })

  const image = process.env['GITORCH_FREE_TIER_AGENT_IMAGE'] ?? process.env['GITORCH_AGENT_IMAGE']
  const engine = process.env['GITORCH_FREE_TIER_CONTAINER_ENGINE'] ?? 'podman'
  const remoteMemoryLimit = process.env['GITORCH_MISSION_MEMORY'] ?? '2g'
  const remoteMissionRunner = createPodmanCommandRunner({
    image: image ?? 'localhost/gitorch-agent:latest',
    podmanBinary: engine,
    userNamespace: 'keep-id',
    memoryLimit: remoteMemoryLimit,
    // Mesmo raciocínio do stack local (ver buildMissionRunner): default sem
    // folga de swap, fechando a mesma fuga provada ao vivo no podman.
    memorySwapLimit: process.env['GITORCH_MISSION_MEMORY_SWAP'] ?? remoteMemoryLimit,
    // Mesmo teto de CPU do stack local (P2-4): mesma resolução, mesmo default
    // e mesma blindagem contra env vazia/inválida (ver config/mission-cpus.ts).
    cpus: resolveMissionCpus(),
    hostRunner: sshRunner,
    // Mesma trava do stack local (ver buildMissionRunner): a verificação sobe
    // pelo MESMO sshRunner, confirmando o gate na imagem do nó remoto real.
    requireGitorchPlugin: true,
  })

  // RemoteWorkspaceProvider exige um runner sempre-Promise; RuntimeCommandRunner
  // permite retorno síncrono (raro, mas o tipo permite) — normaliza com Promise.resolve.
  const remoteWorkspaceProvider = new RemoteWorkspaceProvider(
    async (cmd) => sshRunner(cmd),
    process.env['GITORCH_FREE_TIER_REMOTE_BASE_DIR']
  )

  return buildRuntimeStack(app, remoteMissionRunner, remoteWorkspaceProvider)
}

/**
 * Decide qual stack usa uma missão: grátis com stack remoto disponível → nó
 * isolado da MT-SaaS; qualquer outro caso (pago, sem plano resolvido, ou
 * grátis sem o stack remoto configurado) → local, o comportamento de sempre.
 * Pura e testável — a decisão de roteamento por tier vive aqui, isolada do
 * resto do dispatch.
 */
export function selectRuntimeStack(
  planId: string | undefined,
  local: RuntimeStack,
  remote: RuntimeStack | null
): RuntimeStack {
  if (planId === 'free' && remote) return remote
  return local
}

export interface SetupMissionRecord {
  id: string
  project: {
    id: string
    wingId: string
    userId: string | null
    runtimeConfig?: unknown
  }
}

export interface SetupMissionOutcome {
  status: 'completed' | 'failed'
  output?: string
  error?: string
}

/** Só o pedaço do Prisma que o board precisa gravar — testável sem mock do client inteiro. */
type SetupBoardPrisma = Pick<PrismaClient, 'project'>

export interface ProvisionSetupMissionDeps {
  /**
   * Presença habilita o passo do board (Task 9): sem `prisma` (chamadas
   * antigas/testes de clone), o passo é pulado por completo — nunca toca
   * rede nem tenta gravar nada. Produção sempre passa `app.prisma`.
   */
  prisma?: SetupBoardPrisma
  /** injeção para teste; default: `new ProjectV2Client({ token })`. */
  createProjectV2Client?: (
    token: string
  ) => Pick<ProjectV2Client, 'findProjectId' | 'createProjectV2'>
  /** injeção para teste; default: `resolveGithubOwnerId(owner, token)`. */
  resolveOwner?: (owner: string, token: string) => Promise<ResolvedOwner>
}

/**
 * Executa de verdade a missão `clone_and_start_engines` do wizard: aloca (e
 * clona) o workspace do projeto no stack ATIVO (local ou remoto, já
 * selecionado por selectRuntimeStack antes de chamar isto). Sem isto a
 * missão criada por setup/submit ficava órfã — nenhum código a consumia — e
 * envelhecia até `failStuckMissions` marcá-la failed, uma falsa falha para
 * algo que nunca rodou (spec setup-wizard-redesign §17.3).
 *
 * Também garante o PRÓPRIO board Projects v2 do projeto (Task 9): antes disto
 * `GITORCH_PROJECT_BOARD` era um env GLOBAL, então todo projeto novo apontava
 * para o board pessoal de outro projeto. Falha ao criar o board NUNCA derruba
 * o provisionamento — `ensureProjectBoard` já degrada sozinho e avisa; aqui só
 * persistimos o resultado quando ele vier não-nulo.
 */
export async function provisionSetupMission(
  mission: SetupMissionRecord,
  activeStack: RuntimeStack,
  githubToken?: string,
  deps: ProvisionSetupMissionDeps = {}
): Promise<SetupMissionOutcome> {
  try {
    await activeStack.workspaceProvider.allocateWorkspace(
      mission.project.userId ?? 'scheduler-user',
      mission.project.id,
      { repository: mission.project.wingId, ...(githubToken ? { token: githubToken } : {}) }
    )

    if (githubToken && deps.prisma) {
      const client = deps.createProjectV2Client
        ? deps.createProjectV2Client(githubToken)
        : new ProjectV2Client({ token: githubToken })
      const board = await ensureProjectBoard({
        repository: mission.project.wingId,
        client,
        resolveOwner: (owner) =>
          deps.resolveOwner
            ? deps.resolveOwner(owner, githubToken)
            : resolveGithubOwnerId(owner, githubToken),
        onWarn: (m) => console.warn(`[Scheduler] ${m}`),
      })

      if (board) {
        const runtimeConfig = (mission.project.runtimeConfig as Record<string, unknown>) ?? {}
        await deps.prisma.project.update({
          where: { id: mission.project.id },
          data: {
            runtimeConfig: {
              ...runtimeConfig,
              envConfig: {
                ...((runtimeConfig['envConfig'] as Record<string, unknown> | undefined) ?? {}),
                GITORCH_PROJECT_BOARD: `${board.owner}/${board.number}`,
              },
            },
          },
        })
      }
    }

    return { status: 'completed', output: `Ambiente provisionado para ${mission.project.wingId}` }
  } catch (err) {
    return { status: 'failed', error: (err as Error).message }
  }
}

/**
 * Decide quais missões de setup PENDENTES (já em ordem FIFO por createdAt)
 * cabem no teto global de concorrência nesta rodada.
 *
 * `otherActiveCount` é tudo que JÁ ocupa uma vaga e não faz parte deste lote
 * (cadência em running, ou pending de outro tipo) — nunca o próprio lote:
 * contar o lote pendente contra si mesmo faria a fila se autobloquear para
 * sempre (a mera existência de itens pendentes já saturaria o teto e nada
 * jamais provaria ter capacidade disponível).
 *
 * Para na primeira que não cabe (FIFO): as seguintes são mais novas e também
 * ficam de fora — sem "furar a fila" processando uma mais nova antes de uma
 * mais velha só porque ela coube por acaso.
 */
export function selectClaimableSetupMissions<T>(
  pendingFifo: T[],
  otherActiveCount: number,
  maxConcurrent: number
): T[] {
  let available = maxConcurrent - otherActiveCount
  const claimable: T[] = []
  for (const mission of pendingFifo) {
    if (available <= 0) break
    claimable.push(mission)
    available -= 1
  }
  return claimable
}

/**
 * Ceifador de BOOT (P2-2/E5): a execução de missão vive numa promise em
 * memória (executeMissionWithFailover, abaixo) — um restart do control-plane
 * deixa (a) a linha `running` fantasma no banco até a varredura de stale
 * (STALE_RUNNING_MS) e (b) o container podman vivo segurando RAM/CPU numa VM
 * compartilhada. DECISÃO DO DONO: a esteira de DEPLOY drena missões em voo
 * (timeout) antes de trocar de versão (F2.3.2) — a instância anterior sempre
 * para por completo antes da nova subir. A única outra instância que pode
 * coexistir é o probe INERTE de pipeline-check (GITORCH_PIPELINE_CHECK=1,
 * F2.1.2), que retorna ANTES de chegar aqui (ver guard no início do plugin) e
 * nunca reap. Logo, no boot, todo container `gitorch-mission-*` e toda
 * missão `running` são órfãos por construção — sem essa garantia isto seria
 * destrutivo (mataria trabalho legítimo). Nunca derruba o boot: falha do
 * runtime de container (podman ausente, permissão, timeout) OU do prisma é
 * capturada e logada aqui — nunca silenciosa, nunca propaga.
 */
export async function runBootReaper(
  app: FastifyInstance,
  run: RuntimeCommandRunner = realRuntimeCommandRunner,
  bootAt: Date = new Date()
): Promise<void> {
  if ((process.env['GITORCH_EXECUTOR'] ?? 'local-process') === 'podman') {
    const engine = process.env['GITORCH_CONTAINER_ENGINE'] ?? 'podman'
    const result = await reapOrphanContainers(run, engine).catch((err: unknown) => {
      app.log.warn(err, '[Scheduler] ceifador: falha ao listar containers órfãos')
      return { removed: [], failed: [] } as ReapResult
    })
    if (result.removed.length > 0) {
      app.log.warn(`[Scheduler] ceifador: ${result.removed.length} container(s) órfão(s) removidos`)
    }
    if (result.failed.length > 0) {
      // Honesto: um `rm -f` que não confirmou remoção NUNCA vira "removido"
      // no log — é exatamente o container-segurando-RAM que este ceifador
      // existe para eliminar (ver ReapResult em boot-reaper.ts).
      app.log.warn(
        { failed: result.failed },
        `[Scheduler] ceifador: ${result.failed.length} container(s) órfão(s) falharam ao remover`
      )
    }
  }

  const failed = await failOrphanRunningMissions(app.prisma, bootAt).catch((err: unknown) => {
    app.log.warn(err, '[Scheduler] ceifador: falha ao marcar missões órfãs')
    return 0
  })
  if (failed > 0) {
    app.log.warn(`[Scheduler] ceifador: ${failed} missão(ões) órfã(s) de restart → failed`)
  }
}

const schedulerPlugin = fp<SchedulerOptions>(async (app: FastifyInstance) => {
  // Modo INERTE do health pré-switch da esteira (F2.3/P1-2): sai ANTES de tocar
  // prisma/engineConnections/cortex — a instância de verificação aponta pro
  // banco de PROD e não pode varrer mission-creds, disparar tick nem disputar
  // missões contra a instância viva. Ver config/pipeline-check.ts.
  if (pipelineCheckEnabled()) {
    // `error`, não `warn` (achado I6): esta é a variável mais perigosa que a
    // branch adiciona — se vazar pro ambiente real, o app sobe, responde
    // health check e serve o front normalmente, mas fica pra sempre inerte
    // (sem tick, sem missão, sem Telegram). Um `warn` se perde no volume
    // normal de log; `error` é impossível de não ver.
    app.log.error(
      '[Scheduler] GITORCH_PIPELINE_CHECK=1: scheduler INERTE (sem tick, sem varredura de creds, sem missões)'
    )
    app.decorate('triggerAgentMission', async (): Promise<TriggerResult> => ({
      triggered: false,
      reason: 'pipeline-check',
    }))
    return
  }

  // Boot timestamp (achado M1): capturado AQUI, no registro do plugin — antes
  // de `app.listen()` sequer devolver, logo antes de qualquer requisição HTTP
  // (e portanto qualquer dispatch de missão via rota admin/QA) ser possível.
  // runBootReaper usa isto pra só falhar missão com `startedAt` ANTERIOR ao
  // boot — nunca uma disparada de verdade nos segundos entre o boot e o
  // ceifador terminar (caminho podman: `ps` + N × `rm -f`).
  const bootAt = new Date()

  // Ceifador de boot (P2-2): nada de "running"/container de missão sobrevive
  // a um restart (ver runBootReaper acima para o raciocínio completo).
  // Fire-and-forget (mesmo padrão da faxina de staging de credenciais
  // abaixo): não atrasa o boot do servidor por causa de uma limpeza
  // best-effort. Nunca sob teste: a suíte inteira roda contra um Prisma de
  // teste/sem podman — disparar aqui marcaria missões de teste como failed e
  // tentaria falar com um runtime de container que não existe (paridade com
  // o guard do tick, mais abaixo).
  if (process.env['NODE_ENV'] !== 'test') {
    void runBootReaper(app, undefined, bootAt).catch((err: unknown) =>
      app.log.error(err, '[Scheduler] ceifador de boot falhou inesperadamente')
    )
  }

  // Instanciado cedo: buildMissionRunner (W1.3.1) precisa dele para resolver o
  // motor VERSIONADO do ambiente do dono do projeto ao montar o stack local; a
  // faxina de ambientes expirados (mais abaixo) reusa a MESMA instância.
  const clientEnvironments = new ClientEnvironmentService(app.prisma)
  const localStack = buildRuntimeStack(
    app,
    buildMissionRunner(app, clientEnvironments),
    buildWorkspaceProvider(app)
  )
  const remoteStack = buildRemoteRuntimeStackIfConfigured(app)

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

  const runTrigger = async (
    role: F6AgentRole,
    projectId?: string,
    onboardingSequence?: F6AgentRole[]
  ): Promise<TriggerResult> => {
    await failStuckMissions()

    // Concorrência elástica: teto de missões ativas simultâneas na VM. Default 1
    // (comportamento atual); sobe via env quando a VM-MT-SaaS (32GB) entrar.
    const active = await app.prisma.mission.count({
      where: { status: { in: ['pending', 'running'] } },
    })
    if (active >= MAX_CONCURRENT_MISSIONS) {
      app.log.warn(
        `[Scheduler] Concorrência cheia (${active}/${MAX_CONCURRENT_MISSIONS}); pulando janela de ${role}`
      )
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
          // Fila prioritária: projetos de donos em planos mais altos (tierRank
          // maior) rodam antes. Empate → mais antigo primeiro (fairness).
          orderBy: [{ user: { plan: { tierRank: 'desc' } } }, { createdAt: 'asc' }],
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

    // Controle de gasto (BYOK): a missão roda no LLM do cliente. Antes de
    // disparar, checa a quota do motor primário e o orçamento de tokens do
    // plano. Quota crítica bloqueia (protege a conta do cliente de estourar);
    // quota baixa só alerta. Ver spend-guard.ts.
    // Fotografa a quota ANTES da missão (medição de consumo por diferença).
    let quotaBefore: number | null = null
    if (project.userId && plan) {
      const conn = await app.prisma.engineConnection.findFirst({
        where: { userId: project.userId, runtime: primary.runtime, status: 'connected' },
        select: { quotaRemaining: true, quotaTotal: true },
      })
      quotaBefore = conn?.quotaRemaining ?? null
      const features = (plan.features ?? {}) as Record<string, unknown>
      const tokenBudget =
        typeof features['maxTokensPerMonth'] === 'number'
          ? (features['maxTokensPerMonth'] as number)
          : null
      let tokensSpent = 0
      if (tokenBudget) {
        const startOfMonth = new Date()
        startOfMonth.setDate(1)
        startOfMonth.setHours(0, 0, 0, 0)
        const agg = await app.prisma.mission.aggregate({
          where: { createdAt: { gte: startOfMonth }, project: { userId: project.userId } },
          _sum: { tokensUsed: true },
        })
        tokensSpent = agg._sum.tokensUsed ?? 0
      }
      const decision = canRunMission({
        quotaRemaining: conn?.quotaRemaining ?? null,
        quotaTotal: conn?.quotaTotal ?? null,
        tokensSpent,
        tokenBudget,
      })
      if (shouldAlertForQuota(decision.health)) {
        app.log.warn(
          `[Scheduler] Quota ${decision.health} no motor ${primary.runtime} do usuário ${project.userId}`
        )
      }
      if (!decision.ok) {
        app.log.warn(
          `[Scheduler] Gasto bloqueado (${decision.reason}) para ${project.userId}; pulando ${role}`
        )
        return { triggered: false, reason: decision.reason ?? 'spend-blocked' }
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
        quotaBefore,
        payload: {
          role,
          triggeredBy: onboardingSequence !== undefined ? 'onboarding' : 'scheduler',
          ...(onboardingSequence !== undefined ? { onboardingSequence } : {}),
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
    void executeMissionWithFailover(mission.id, project, role, chain, plan?.id)

    return { triggered: true, missionId: mission.id }
  }

  type ChainProject = {
    id: string
    wingId: string
    name: string
    userId: string | null
    runtimeConfig?: unknown
  }

  // Tenta a cadeia de motores em ordem; sucesso encerra; erro de cota/auth cai
  // para o próximo; erro real encerra em failed. Nunca mascara: o estado final
  // é sempre gravado (completed com o motor que deu certo, ou failed com o erro).
  const executeMissionWithFailover = async (
    missionId: string,
    project: ChainProject,
    role: F6AgentRole,
    chain: Array<{ runtime: string; model?: string }>,
    planId?: string
  ): Promise<void> => {
    // Isolamento por tier: grátis roda no stack remoto (MT-SaaS) quando
    // configurado; qualquer outro caso usa o stack local de sempre — nunca
    // corre o risco de rotear uma missão paga para fora da nossa VM.
    const activeStack = selectRuntimeStack(planId, localStack, remoteStack)
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
        const credentialRef = {
          connectionId: `conn-${role}-${missionId}-${sel.runtime}`,
          ownerScope: 'project' as const,
          runtime: sel.runtime as F6AgentRuntime,
          providedSecrets: [],
          ...(project.userId ? { ownerUserId: project.userId } : {}),
        }

        // Lei "LLM decide, sistema executa": PO e QA rodam nos TRILHOS quando o
        // token do GitHub (e, para o PO, o board) estão configurados. O token é a
        // identidade própria do gitorch — um installation token do seu GitHub App,
        // emitido sob demanda e cacheado ~1h. Um GITORCH_GITHUB_TOKEN explícito, se
        // definido, tem prioridade (override). Sem App/token, cai no caminho
        // clássico com log honesto.
        //
        // Board (Task 9): o PRÓPRIO board do projeto (gravado em
        // Project.runtimeConfig.envConfig.GITORCH_PROJECT_BOARD por
        // provisionSetupMission) tem prioridade sobre o env global — o env
        // global (hoje `loureng/9`, board pessoal de outro projeto) só entra
        // como ÚLTIMO RECURSO, para projetos criados antes desta task.
        const boardDoProjeto = (
          (project.runtimeConfig as Record<string, unknown> | null)?.['envConfig'] as
            Record<string, unknown> | undefined
        )?.['GITORCH_PROJECT_BOARD'] as string | undefined
        const railsBoard = boardDoProjeto ?? process.env['GITORCH_PROJECT_BOARD']
        const railsToken =
          process.env['GITORCH_GITHUB_TOKEN'] ?? (await mintInstallationToken()) ?? undefined
        const poRails = role === 'po' && Boolean(railsBoard) && Boolean(railsToken)
        const qaRails = role === 'qa' && Boolean(railsToken)
        const smRails = role === 'sm' && Boolean(railsToken)
        // RA não age no GitHub: os trilhos dele (áreas→jornadas→brief) só
        // precisam do motor — sempre disponíveis.
        const raRails = role === 'ra'
        let result: { exitCode: number; output: string; stderr: string; noOp?: boolean }

        if (smRails) {
          // SM é o dono da esteira, 100% determinístico (sem passo de LLM):
          // (1) delega tasks prontas e desbloqueadas; (2) watchdog do dev
          // assíncrono — falha do Jules dispara o retry oficial (re-label),
          // com cap e escalação humana (gitorch:stuck + Telegram).
          const delegation = await runSmDelegation({
            repository: project.wingId,
            githubToken: railsToken as string,
          })
          // O aviso é do DONO do projeto — a task travada é a dele. Antes, o
          // chat vinha direto do env (GITORCH_TELEGRAM_CHAT_ID): TODO cliente
          // "notificado" caía no chat da gitorch e o cliente, que informara o
          // Telegram dele no wizard, nunca recebia nada. Agora o chat sai do
          // vínculo real (telegram_links, nascido do /start do próprio cliente);
          // o nosso chat só entra quando o projeto é NOSSO — aí é notificação
          // interna de verdade. Sem vínculo, ninguém é avisado: o repo/issue de
          // um cliente não vira mensagem no chat de outro nem no nosso.
          const notifyChatId = await resolveNotifyChatId(app.prisma, project, {
            instanceOwnerEmail: process.env['GITORCH_OWNER_EMAIL'],
            instanceChatId:
              process.env['GITORCH_TELEGRAM_CHAT_ID'] ?? process.env['TELEGRAM_CHAT_ID'],
          })
          const notify = buildTelegramNotifier({
            botToken:
              process.env['GITORCH_TELEGRAM_BOT_TOKEN'] ?? process.env['TELEGRAM_BOT_TOKEN'],
            ...(notifyChatId ? { chatId: notifyChatId } : {}),
          })
          const watchdog = await runSmWatchdog({
            repository: project.wingId,
            githubToken: railsToken as string,
            ...(notify ? { notify } : {}),
          })
          // Sensor de incidentes (os "olhos"): idempotente por fingerprint —
          // rodar a cada wake do SM não duplica nada. Best-effort.
          let sensorOut = ''
          let sensorNoOp = true
          try {
            const sensor = await runIncidentSensor({
              repository: project.wingId,
              githubToken: railsToken as string,
            })
            sensorOut = sensor.output
            sensorNoOp = sensor.noOp === true
          } catch (sensorErr) {
            app.log.warn(sensorErr, '[Scheduler] sensor de incidentes falhou')
            sensorOut = 'sensor: failed (see logs).'
          }
          result = {
            exitCode: 0,
            output: [delegation.output, watchdog.output, sensorOut].join('\n'),
            stderr: '',
            noOp: delegation.noOp === true && watchdog.noOp === true && sensorNoOp,
          }
        } else if (poRails || qaRails || raRails) {
          const stepDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitorch-rails-'))
          let stepN = 0
          // Executor de passo: uma execução curta do motor por formulário.
          const execute = async (prompt: string): Promise<string> => {
            stepN += 1
            const adapter = activeStack.registry.resolve(sel.runtime as F6AgentRuntime)
            const step = await adapter.run({
              missionId: `${missionId}-step-${stepN}`,
              prompt,
              runtime: { runtime: sel.runtime as F6AgentRuntime, model },
              credentialRef,
              role,
              cwd: stepDir,
              timeoutMs: 10 * 60 * 1000,
            })
            if (step.exitCode !== 0) {
              throw new Error(`rails step ${stepN} failed: ${step.stderr.slice(0, 300)}`)
            }
            return step.output
          }
          try {
            // Codegraph REAL antes de decidir: clona/atualiza o repo do cliente
            // e injeta o resumo estrutural — sem isso o PO escreveria
            // "Implementation Guide"/"Related Files" no chute e a issue chega
            // fraca no dev assíncrono. Best-effort: sem workspace, segue só
            // com memória.
            let workspacePath: string | undefined
            try {
              const ws = (await activeStack.workspaceProvider.allocateWorkspace(
                project.userId ?? 'scheduler-user',
                project.id,
                { repository: project.wingId }
              )) as { path?: string } | undefined
              workspacePath = ws?.path
            } catch (wsErr) {
              app.log.warn(wsErr, `[Scheduler] rails sem workspace para ${project.wingId}`)
            }
            const contextBlocks = await buildMissionEnricher({ cortex: app.cortex })({
              projectId: project.id,
              role,
              ...(workspacePath ? { workspacePath } : {}),
            })
            // Colunas do board: config POR PROJETO (runtimeConfig.board.columns),
            // com default nativo — o cliente personaliza, o backend acompanha.
            const boardColumns = resolveBoardColumns(project.runtimeConfig)
            result = raRails
              ? await runRaMissionViaRails({
                  repository: project.wingId,
                  githubToken: railsToken,
                  execute,
                  contextBlocks,
                })
              : poRails
                ? await runPoMissionViaRails({
                    repository: project.wingId,
                    board: railsBoard as string,
                    githubToken: railsToken as string,
                    contextBlocks,
                    boardColumns,
                    sprintDays: resolveSprintDays(project.runtimeConfig),
                    execute,
                    projectId: project.id,
                    userId: project.userId ?? undefined,
                    agentQuestionService: app.agentQuestionService,
                  })
                : await runQaMissionViaRails({
                    repository: project.wingId,
                    githubToken: railsToken as string,
                    contextBlocks,
                    // O QA move o card da issue conforme o veredito (se há board).
                    ...(railsBoard
                      ? {
                          moveCard: createCardMover({
                            repository: project.wingId,
                            board: railsBoard,
                            token: railsToken as string,
                            columns: boardColumns,
                          }),
                        }
                      : {}),
                    execute,
                  })
          } finally {
            await fs.rm(stepDir, { recursive: true, force: true }).catch(() => undefined)
          }
        } else {
          if (role === 'po' || role === 'qa') {
            app.log.info(`[Scheduler] ${role} sem GITHUB_TOKEN/board: usando caminho clássico`)
          }
          result = await activeStack.orchestrator.runMission({
            id: missionId,
            projectId: project.id,
            repository: project.wingId,
            role,
            goal: `Analyze and coordinate tasks for ${project.name}`,
            context: [],
            runtime: { runtime: sel.runtime as F6AgentRuntime, model },
            credentialRef,
            userId: project.userId ?? 'scheduler-user',
            timeoutMs: STALE_RUNNING_MS,
          })
        }

        const entrega =
          result.exitCode === 0
            ? assertMissionDelivered(role, result.output)
            : ({ delivered: false, reason: `motor saiu com codigo ${result.exitCode}` } as const)

        if (result.exitCode === 0 && !entrega.delivered) {
          // Verde mentiroso: o motor respondeu, mas não entregou. Falha honesta
          // com o motivo, e NADA vai para a memória do projeto.
          app.log.warn(`[Scheduler] Mission ${missionId} sem entregavel: ${entrega.reason}`)
          await app.prisma.mission.updateMany({
            where: { id: missionId, status: 'running' },
            data: {
              status: 'failed',
              completedAt: new Date(),
              error: entrega.reason,
              result: { output: result.output, stderr: result.stderr, runtime: sel.runtime },
            },
          })
          return
        }

        if (result.exitCode === 0 && entrega.delivered) {
          // O entregável vira memória tipada do projeto — exceto no-ops (ex.:
          // "sem wishlist"), que poluiriam o recall e expulsariam o brief do RA.
          const isNoOp = (result as { noOp?: boolean }).noOp === true
          if (!isNoOp) {
            await persistMissionMemory(app.cortex, {
              projectId: project.id,
              role,
              content: result.output,
              now: new Date().toISOString(),
            })
          }

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

          // Medição de consumo (ideia do owner): refresca a quota do motor que
          // rodou e grava a diferença antes−depois na missão. Best-effort: nunca
          // quebra a conclusão. Só funciona quando o provider expõe quota.
          if (project.userId) {
            try {
              await app.engineConnections.refreshModels(project.userId, sel.runtime)
              const after = await app.prisma.engineConnection.findFirst({
                where: { userId: project.userId, runtime: sel.runtime, status: 'connected' },
                select: { quotaRemaining: true },
              })
              const before =
                (
                  await app.prisma.mission.findUnique({
                    where: { id: missionId },
                    select: { quotaBefore: true },
                  })
                )?.quotaBefore ?? null
              const c = computeConsumption(before, after?.quotaRemaining ?? null)
              if (c.quotaAfter != null || c.tokensUsed != null) {
                await app.prisma.mission.update({
                  where: { id: missionId },
                  data: { quotaAfter: c.quotaAfter, tokensUsed: c.tokensUsed },
                })
                app.log.info(
                  `[Scheduler] Consumo ${missionId}: antes=${before} depois=${c.quotaAfter} usou=${c.tokensUsed}`
                )
              }
            } catch (e) {
              app.log.warn({ e }, `[Scheduler] medição de consumo falhou para ${missionId}`)
            }
          }
          if (!isNoOp) {
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

            // Encadeamento automático de onboarding (Evento 1)
            try {
              const m = await app.prisma.mission.findUnique({
                where: { id: missionId },
                select: { payload: true, projectId: true },
              })
              const p = m?.payload as { onboardingSequence?: F6AgentRole[] } | null
              const seq = p?.onboardingSequence
              if (seq && seq.length > 0) {
                const [nextRole, ...remaining] = seq
                app.log.info(
                  `[Scheduler] Onboarding (${role} concluído): disparando ${nextRole} para ${project.wingId}`
                )
                void triggerAgentMission(
                  nextRole as F6AgentRole,
                  m?.projectId,
                  remaining as F6AgentRole[]
                )
              }
            } catch (chainErr) {
              app.log.error(chainErr, `[Scheduler] Falha ao encadear onboarding após ${role}`)
            }
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
        // Classificação de origem do erro (Lei dos trilhos):
        // - GithubExecutionError: o GitHub falhou (token/rate-limit do REPO) —
        //   igual para TODOS os motores; failover só repetiria o dano. Falha já.
        // - RailsStepError: o MOTOR não preencheu o formulário — é exatamente o
        //   caso do failover (o próximo motor do cliente pode conseguir).
        // - Demais: failover apenas para cota/rate/auth (padrão existente).
        if (err instanceof GithubExecutionError) {
          app.log.error(err, `[Scheduler] erro de execução no GitHub; sem failover`)
          break
        }
        const engineFault = err instanceof RailsStepError || isFailoverError(lastError)
        if (!isLast && engineFault) {
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
    projectId?: string,
    onboardingSequence?: F6AgentRole[]
  ): Promise<TriggerResult> => {
    app.log.info(`[Scheduler] Triggering agent mission for role: ${role}`)
    // Encadeia os disparos para que nunca rodem concorrentes (guard sem corrida).
    const result = triggerChain.then(
      () => runTrigger(role, projectId, onboardingSequence),
      () => runTrigger(role, projectId, onboardingSequence)
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
    'engine-quota-critical',
    'token-budget',
    'error',
    'init',
  ])

  // Processa as missões `clone_and_start_engines` que o wizard cria ao
  // finalizar o cadastro — sem isto elas ficavam órfãs (spec §17.3). Roda a
  // cada tick (mesma cadência do resto do dispatch); claim condicional evita
  // dois ticks pegarem a mesma missão.
  const processSetupMissions = async (): Promise<void> => {
    let pending
    try {
      pending = await app.prisma.mission.findMany({
        where: { type: 'clone_and_start_engines', status: 'pending' },
        // FIFO: a mais antiga primeiro — mesma ordem da fila visível em
        // GET /api/v1/setup/status (queuePosition).
        orderBy: { createdAt: 'asc' },
        include: { project: { include: { user: { include: { plan: true } } } } },
      })
    } catch (err) {
      app.log.error(err, '[Scheduler] falha ao ler missões de setup pendentes')
      return
    }

    if (pending.length === 0) return

    // O wizard passa a respeitar o MESMO teto global da cadência: antes disto
    // processSetupMissions nunca checava concorrência nenhuma e disparava
    // clone+subida de motores sem limite, ignorando o orçamento de CPU/RAM da
    // VM. `active` é a mesma contagem pending+running que runTrigger usa;
    // subtraímos o próprio lote (todo pending, então já contado ali) para
    // achar o que outra coisa já ocupa.
    const active = await app.prisma.mission.count({
      where: { status: { in: ['pending', 'running'] } },
    })
    const otherActiveCount = active - pending.length
    const claimable = selectClaimableSetupMissions(
      pending,
      otherActiveCount,
      MAX_CONCURRENT_MISSIONS
    )
    const claimableIds = new Set(claimable.map((m) => m.id))

    for (const mission of pending) {
      if (!claimableIds.has(mission.id)) {
        app.log.warn(
          `[Scheduler] Concorrência cheia (${MAX_CONCURRENT_MISSIONS}); setup mission ${mission.id} (${mission.project.wingId}) fica na fila`
        )
        continue
      }

      const claimed = await app.prisma.mission.updateMany({
        where: { id: mission.id, status: 'pending' },
        data: { status: 'running', startedAt: new Date() },
      })
      if (claimed.count === 0) continue // outro tick já reivindicou esta missão

      const activeStack = selectRuntimeStack(
        mission.project.user?.plan?.id,
        localStack,
        remoteStack
      )
      // Repositório privado clona com o token do PRÓPRIO dono do projeto
      // (cofre cifrado) — nunca uma credencial do host.
      const githubToken = mission.project.userId
        ? await app.engineConnections.getRawGithubToken(mission.project.userId)
        : null
      const outcome = await provisionSetupMission(mission, activeStack, githubToken ?? undefined, {
        prisma: app.prisma,
      })
      await app.prisma.mission.update({
        where: { id: mission.id },
        data: {
          status: outcome.status,
          completedAt: new Date(),
          ...(outcome.output ? { result: { output: outcome.output } } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
        },
      })
      if (outcome.status === 'failed') {
        app.log.error(
          `[Scheduler] provisionamento do projeto ${mission.project.wingId} falhou: ${outcome.error}`
        )
      } else if (outcome.status === 'completed') {
        // Trigger next mission in onboarding sequence if present
        const payload = mission.payload as { onboardingSequence?: F6AgentRole[] } | null
        const seq = payload?.onboardingSequence
        if (seq && seq.length > 0) {
          const [nextRole, ...remaining] = seq
          app.log.info(
            `[Scheduler] Setup concluído para ${mission.project.wingId}. Disparando onboarding: ${nextRole}`
          )
          void triggerAgentMission(
            nextRole as F6AgentRole,
            mission.projectId,
            remaining as F6AgentRole[]
          )
        }
      }
    }
  }

  // Agenda dirigida a dados: cada projeto define seu cron por agente em
  // project_schedules. A cada minuto, dispara o que venceu desde o último
  // disparo registrado. O claim condicional do lastTriggeredAt impede dois
  // ticks de dispararem a mesma janela; quando o disparo é recusado por um
  // motivo temporário (missão em andamento, orçamento), o claim é revertido
  // para a janela não se perder.
  // Faxina do ciclo de vida do ambiente: destrói ambientes provisórios (não
  // fixados) SEM ATIVIDADE há mais de 24h — abandonados no wizard, guardam
  // credencial + OAuth do cliente e não podem ficar largados (requisito de
  // segurança). O relógio é de INATIVIDADE, não de idade: o cliente que ainda
  // está usando o wizard renova o ambiente a cada passo real (ver
  // ClientEnvironmentService.touch) e nunca é varrido no meio do cadastro.
  const ENV_TTL_MS = Number(process.env['GITORCH_ENV_TTL_MS'] ?? String(24 * 60 * 60 * 1000))
  const sweepExpiredEnvironments = async (): Promise<void> => {
    try {
      const expired = await clientEnvironments.listExpired(ENV_TTL_MS)
      for (const env of expired) {
        await clientEnvironments.destroy(env.id)
        app.log.info(`[Scheduler] ambiente provisório abandonado destruído: ${env.id}`)
      }
    } catch (err) {
      app.log.error(err, '[Scheduler] faxina de ambientes falhou; tenta no próximo tick')
    }
  }

  const tick = async () => {
    await processSetupMissions()
    await sweepExpiredEnvironments()
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

  // Loop de verificação a cada minuto (GITORCH_SCHEDULER_TICK_MS sobrescreve —
  // usado pelo E2E do funil completo com GITORCH_FAKE_ENGINES=1 para não
  // esperar até 60s pela missão clone_and_start_engines processar; ausente,
  // comportamento de sempre). Não roda sob teste para não vazar timer nem
  // disparar missão real contra o Prisma de teste (paridade com
  // under-pressure). A execução é envolvida para nunca propagar rejeição (o
  // processo não cai).
  const intervalId =
    process.env['NODE_ENV'] === 'test'
      ? undefined
      : setInterval(
          () => {
            void tick().catch((err) => app.log.error(err, '[Scheduler] tick rejeitou'))
          },
          Number(process.env['GITORCH_SCHEDULER_TICK_MS'] ?? 60 * 1000)
        )

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
    triggerAgentMission: (
      role: F6AgentRole,
      projectId?: string,
      onboardingSequence?: F6AgentRole[]
    ) => Promise<TriggerResult>
  }
}

export default schedulerPlugin
export { schedulerPlugin }
