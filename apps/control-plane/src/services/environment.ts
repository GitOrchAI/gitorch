import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Prisma, type PrismaClient } from '@prisma/client'
import { LocalWorkspaceProvider } from '@gitorch/workspace-engine'
import { buildChildProcessEnv, wrapWithLimits, type ExecutionLimits } from '@gitorch/agents'

type PrismaLike = Pick<PrismaClient, 'clientEnvironment'>

// Só o que o serviço usa do provider — permite injetar um fake nos testes,
// sem git real.
type WorkspaceAllocator = Pick<LocalWorkspaceProvider, 'allocateWorkspace'>

export interface ClientEnvironmentRecord {
  id: string
  userId: string
  /** SÓ o ciclo de vida do wizard: 'provisional' | 'fixed'. */
  status: string
  path: string
  /**
   * Progresso do bootstrap de recursos, DESACOPLADO de `status` (correção do
   * bug de timing — ver schema.prisma): null | 'provisioning' | 'ready' | 'error'.
   * Opcional no TIPO (não no banco — a coluna sempre existe) só para não
   * quebrar fakes de outros testes (ex.: scheduler.ts) que constroem um
   * ClientEnvironmentRecord parcial sem este campo novo.
   */
  resourcesStatus?: string | null
  /** Versões instaladas pelo bootstrap (env-lock.json) — null até rodar/falhar. */
  resourcesLock: unknown
  fixedAt: Date | null
  createdAt: Date
  updatedAt: Date
  /** Última atividade REAL do cliente neste ambiente — o relógio da faxina. */
  lastActivityAt: Date
}

/** Resultado cru (sem interpretar sucesso/erro) de rodar o script de bootstrap. */
export interface BootstrapRunResult {
  exitCode: number
  stderr: string
}

/**
 * Roda `infra/bootstrap-env.sh <envDir>` (script PRIVADO, path via
 * GITORCH_BOOTSTRAP_SCRIPT) e devolve o resultado cru. Injetável — os testes
 * usam um fake determinístico, NUNCA o script real (que instala CLIs de
 * verdade via npm/cópia+sha256).
 */
export type BootstrapRunner = (envDir: string) => Promise<BootstrapRunResult>

/** Resultado interpretado de `bootstrapResources`: honesto sobre sucesso/causa. */
export interface BootstrapResourcesResult {
  ok: boolean
  /** Causa REAL da falha (stderr do script, ou o motivo do env-lock ausente/inválido). */
  error?: string
  /** Conteúdo do env-lock.json quando `ok` — o mesmo que fica em resourcesLock. */
  lock?: unknown
}

const execFileAsync = promisify(execFile)

// 10min: a 1ª instalação de uma versão de motor faz `npm install -g` (pode
// demorar); instalações seguintes do MESMO ambiente/versão reusam o cache
// compartilhado (ver infra/bootstrap-env.sh) e terminam em segundos. Só entra
// em vigor no runner REAL — os testes usam um runner fake sem timeout algum.
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10 * 60 * 1000

// Mesmo teto (env vars) que packages/agents/runtime-adapter.ts usa para a
// execução de missões — GITORCH_EXEC_LIMITS=systemd (com systemd-run no
// PATH) prefixa o comando com o cgroup transitório; em qualquer outro caso
// (default) o comando roda cru, sem alterar o comportamento atual da VM.
const BOOTSTRAP_EXEC_LIMITS: ExecutionLimits = {
  memoryMax: process.env['GITORCH_EXEC_MEMORY_MAX'] ?? '2G',
  cpuQuota: process.env['GITORCH_EXEC_CPU_QUOTA'] ?? '150%',
}

function normalizeExitCode(code: unknown): number {
  return typeof code === 'number' ? code : 1
}

// Passa só o essencial pro script (nunca process.env inteiro: o control
// plane carrega DATABASE_URL/JWT_SECRET/tokens — o script é infra confiável,
// mas defesa em profundidade é grátis aqui) + os GITORCH_* que o PRÓPRIO
// script reconhece (ver infra/bootstrap-env.sh), quando o operador os
// configurou nesta instância.
function buildBootstrapEnv(): Record<string, string> {
  const passthroughKeys = [
    'GITORCH_MANIFEST_PATH',
    'GITORCH_ENGINES_CACHE',
    'GITORCH_AGY_BIN',
  ] as const
  const passthrough: Record<string, string> = {}
  for (const key of passthroughKeys) {
    const value = process.env[key]
    if (value !== undefined) passthrough[key] = value
  }
  return { ...buildChildProcessEnv({}), ...passthrough }
}

/**
 * Runner REAL: dispara `GITORCH_BOOTSTRAP_SCRIPT <envDir>` via execFile (sem
 * shell), com o teto de recurso do `wrapWithLimits` e timeout. Sem a env var
 * configurada, rejeita cedo com uma causa clara — nunca finge que rodou.
 */
export const realBootstrapRunner: BootstrapRunner = async (envDir) => {
  const scriptPath = process.env['GITORCH_BOOTSTRAP_SCRIPT']
  if (!scriptPath) {
    throw new Error(
      'GITORCH_BOOTSTRAP_SCRIPT não definido — não é possível instalar os recursos do ambiente'
    )
  }
  const timeoutMs = Number(
    process.env['GITORCH_BOOTSTRAP_TIMEOUT_MS'] ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS
  )
  const { binary, args } = wrapWithLimits(scriptPath, [envDir], BOOTSTRAP_EXEC_LIMITS)
  try {
    const { stderr } = await execFileAsync(binary, args, {
      env: buildBootstrapEnv(),
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    })
    return { exitCode: 0, stderr }
  } catch (error: unknown) {
    const err = error as {
      code?: number | string
      killed?: boolean
      signal?: string
      stderr?: string
      message?: string
    }
    const timedOut = err.killed === true || err.signal === 'SIGKILL'
    return {
      exitCode: timedOut ? 124 : normalizeExitCode(err.code),
      stderr: err.stderr || err.message || String(error),
    }
  }
}

/**
 * Gerencia o ciclo de vida do ambiente isolado de cada cliente no setup wizard.
 * O ambiente nasce 'provisional' no aceite dos termos, acumula o clone dos
 * repos e as credenciais de motor logadas dentro dele, e vira 'fixed' no aceite
 * final. Um garbage collector (à parte) destrói 'provisional' SEM ATIVIDADE há
 * mais de 24h — o TTL mede INATIVIDADE, não idade (ver `touch`/`listExpired`).
 *
 * `bootstrapResources` instala os recursos VERSIONADOS do manifesto DENTRO do
 * ambiente (null -> 'provisioning' -> 'ready'/'error') — mas em
 * `resourcesStatus`, um campo PRÓPRIO e DESACOPLADO do `status` do ciclo de
 * vida acima. Isso importa porque o disparo agora acontece cedo (no clone,
 * passo 4/5, ver routes/setup.ts), bem ANTES do aceite final (passo 10): se o
 * bootstrap escrevesse em `status` (como antes deste fix), um ambiente ainda
 * em pleno wizard sairia de 'provisional' NO MEIO do processo, e
 * fix()/createProvisional()/listExpired() — que só reconhecem
 * 'provisional'/'fixed' — parariam de enxergá-lo (o aceite final nunca
 * fixava, e a faxina de segurança de 24h deixava de proteger a credencial do
 * ambiente abandonado nesse meio-tempo).
 *
 * O diretório base é infra da VM: vem de GITORCH_ENVIRONMENTS_DIR (nunca
 * hardcoded fixo), mesmo padrão do LocalWorkspaceProvider. O `path` guardado
 * é interno — nunca deve ser exposto ao frontend.
 */
export class ClientEnvironmentService {
  private readonly baseDir: string
  private readonly provider: WorkspaceAllocator
  private readonly bootstrapRunner: BootstrapRunner

  constructor(
    private readonly prisma: PrismaLike,
    baseDir = process.env['GITORCH_ENVIRONMENTS_DIR'] ?? '/var/lib/gitorch/environments',
    provider?: WorkspaceAllocator,
    bootstrapRunner?: BootstrapRunner
  ) {
    this.baseDir = baseDir
    this.provider = provider ?? new LocalWorkspaceProvider(baseDir)
    this.bootstrapRunner = bootstrapRunner ?? realBootstrapRunner
  }

  /**
   * Cria (ou reusa) o ambiente provisório do usuário. Idempotente: se já há um
   * 'provisional' aberto, devolve ele em vez de criar outro — recarregar o
   * wizard não pode multiplicar ambientes, pois cada um passa a guardar as
   * credenciais do cliente em disco. Cria um diretório 0700 exclusivo (só o
   * dono acessa), nomeado pelo id do registro.
   *
   * Reusar é ATIVIDADE: renova o relógio da faxina. Este método é o FUNIL por
   * onde passam o aceite dos termos (/setup/environment), o clone dos repos
   * (/setup/clone) e o início do login de motor (engines) — renovando aqui,
   * nenhum desses passos pode ser esquecido.
   */
  async createProvisional(userId: string): Promise<ClientEnvironmentRecord> {
    const existing = await this.prisma.clientEnvironment.findFirst({
      where: { userId, status: 'provisional' },
      orderBy: { createdAt: 'desc' },
    })
    if (existing) {
      const renewed = await this.prisma.clientEnvironment.update({
        where: { id: existing.id },
        data: { lastActivityAt: new Date() },
      })
      return renewed as ClientEnvironmentRecord
    }

    const created = await this.prisma.clientEnvironment.create({
      data: { userId, status: 'provisional', path: '', lastActivityAt: new Date() },
    })
    const dir = path.join(this.baseDir, created.id)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })

    const updated = await this.prisma.clientEnvironment.update({
      where: { id: created.id },
      data: { path: dir },
    })

    // Corrida (dois aceites simultâneos): o canônico é sempre o MAIS RECENTE —
    // o mesmo critério do findFirst desc usado em todo o serviço, então clone
    // e login convergem pro mesmo ambiente. Se este create perdeu a corrida
    // (existe um mais novo), destrói o próprio e devolve o vencedor; um
    // perdedor que escapar desta janela continua 'provisional' e a faxina 24h
    // o destrói. O dedup definitivo acontece no fix() antes de fixar.
    const winner = await this.prisma.clientEnvironment.findFirst({
      where: { userId, status: 'provisional' },
      orderBy: { createdAt: 'desc' },
    })
    if (winner && winner.id !== updated.id) {
      await this.destroy(updated.id)
      return winner as ClientEnvironmentRecord
    }
    return updated as ClientEnvironmentRecord
  }

  /**
   * Clona os repositórios escolhidos DENTRO do ambiente do cliente (passo 4),
   * cada um num subdiretório do ambiente (nomeado pelo envId). Reusa o
   * LocalWorkspaceProvider, que autentica com o token do PRÓPRIO cliente por
   * invocação (nunca grava a credencial em disco/URL) e sanitiza erros de git.
   * Os clones ficam sob o diretório 0700 do ambiente, protegidos.
   */
  async cloneInto(
    envId: string,
    repos: string[],
    token?: string
  ): Promise<Array<{ repo: string; path: string }>> {
    const cloned: Array<{ repo: string; path: string }> = []
    for (const repo of repos) {
      // O provider valida o projectId com /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/ —
      // que REJEITA a barra de "owner/repo". Passar o repo cru quebrava o
      // clone para QUALQUER repositório real (500 no /setup/clone), e os
      // testes não pegavam porque mockavam o provider. O slug sanitizado é o
      // MESMO esquema do repoPathInEnv (owner_repo) — os dois têm que andar
      // juntos, senão o diagnóstico não reencontra o clone.
      const slug = repo.replace(/[^a-zA-Z0-9_-]/g, '_')
      // exactOptionalPropertyTypes: só inclui `token` quando existe (nunca
      // passa `undefined` explícito ao provider).
      const options = token !== undefined ? { repository: repo, token } : { repository: repo }
      const ws = await this.provider.allocateWorkspace(envId, slug, options)
      cloned.push({ repo, path: ws.path })
    }
    return cloned
  }

  /**
   * Caminho do clone de um repo DENTRO do ambiente provisório do usuário —
   * mesmo esquema de path do cloneInto. Retorna null se não há ambiente ou o
   * repo ainda não foi clonado. Serve pro diagnóstico reaproveitar o clone do
   * passo 4 em vez de clonar de novo (não clonar 2x).
   */
  async repoPathInEnv(userId: string, repo: string): Promise<string | null> {
    try {
      const env = await this.prisma.clientEnvironment.findFirst({
        where: { userId, status: 'provisional' },
        orderBy: { createdAt: 'desc' },
      })
      if (!env?.path) return null
      const sanitized = repo.replace(/[^a-zA-Z0-9_-]/g, '_')
      const dir = path.join(env.path, sanitized)
      // Guard de contenção (idioma canônico via path.relative, o que o CodeQL
      // reconhece de forma confiável como sanitizador de path traversal — um
      // startsWith manual NÃO fechou o alerta numa 1a tentativa): `repo` é
      // input do cliente (nome de repositório escolhido no wizard). O replace
      // acima já elimina barras/pontos, mas isto é defesa em profundidade —
      // se `dir` escapar de env.path por QUALQUER via, `relative` começa com
      // '..' ou vira absoluto, e o guard barra antes do fs.stat.
      const resolvedEnvPath = path.resolve(env.path)
      const resolvedDir = path.resolve(dir)
      const relativeToEnv = path.relative(resolvedEnvPath, resolvedDir)
      if (relativeToEnv.startsWith('..') || path.isAbsolute(relativeToEnv)) {
        return null
      }
      const cloned = await fs
        .stat(path.join(resolvedEnvPath, relativeToEnv, '.git'))
        .then((s) => s.isDirectory())
        .catch(() => false)
      return cloned ? resolvedDir : null
    } catch {
      // Reuso é otimização best-effort: se o lookup do ambiente falhar, o
      // diagnóstico cai no clone próprio (diag-<repo>) — nunca quebra o fluxo.
      return null
    }
  }

  /**
   * O ambiente ATUAL do usuário (o mais recente — mesmo critério `desc` que
   * createProvisional/fix usam para eleger o canônico), ou null se ele não tem
   * nenhum. Alimenta o status do provisionamento no fim do wizard: o cliente vê
   * o estado real do ambiente dele (provisional/fixed). Quem chama só pode
   * expor `id` e `status` — o `path` é infra e NUNCA vai pro frontend.
   */
  async current(userId: string): Promise<ClientEnvironmentRecord | null> {
    const env = await this.prisma.clientEnvironment.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    })
    return (env as ClientEnvironmentRecord | null) ?? null
  }

  /**
   * Renova o relógio da faxina: marca ATIVIDADE REAL do cliente no ambiente
   * provisório dele. Chamado quando o cliente faz algo de fato no wizard — e o
   * `createProvisional` (funil dos termos, do clone e do início do login) já
   * renova sozinho; este `touch` cobre a atividade que NÃO passa por lá, como
   * concluir o login de um motor.
   *
   * Idempotente e inofensivo: `updateMany` não falha se o usuário não tem
   * ambiente aberto, e o escopo (userId + 'provisional') garante que jamais
   * ressuscita um ambiente fixado nem toca no de outro cliente.
   */
  async touch(userId: string): Promise<void> {
    await this.prisma.clientEnvironment.updateMany({
      where: { userId, status: 'provisional' },
      data: { lastActivityAt: new Date() },
    })
  }

  /**
   * Ambientes provisórios (não-fixados) SEM ATIVIDADE há mais de `maxAgeMs`.
   * Alimenta o garbage collector: um ambiente abandonado guarda credenciais +
   * OAuth do cliente e não pode ficar largado — a faxina é requisito de
   * SEGURANÇA e continua valendo.
   *
   * O corte é por INATIVIDADE (`lastActivityAt`), não por idade (`createdAt`):
   * cortando por idade, o cliente que aceitava os termos, conectava os motores e
   * voltava pra terminar o wizard depois de 24h tinha o ambiente destruído NO
   * MEIO do cadastro — com o clone e as credenciais dentro. Quem realmente
   * abandonou não renova nada e é destruído do mesmo jeito.
   */
  async listExpired(
    maxIdleMs: number,
    now: number = Date.now()
  ): Promise<ClientEnvironmentRecord[]> {
    const cutoff = new Date(now - maxIdleMs)
    const rows = await this.prisma.clientEnvironment.findMany({
      where: { status: 'provisional', lastActivityAt: { lt: cutoff } },
    })
    return rows as ClientEnvironmentRecord[]
  }

  /**
   * Destrói um ambiente: apaga o diretório em disco (com as credenciais) e o
   * registro. O rm é contido ao baseDir (guard de path-traversal) — nunca apaga
   * fora da raiz de ambientes. A ORDEM importa para SEGURANÇA: o registro do
   * banco é a ÚNICA forma do GC (listExpired varre linhas do banco) reencontrar
   * o dir; por isso só apaga o registro DEPOIS do dir sumir (rm OK, ou dir
   * inexistente — force:true resolve sem erro). Se o rm falhar (disco ocupado,
   * lock, permissão), preserva o registro e retorna: apagá-lo aqui deixaria a
   * credencial órfã em disco FORA do alcance da faxina. O GC retenta no tick
   * seguinte. Quando o guard barra a remoção (rel vazio/'..'/absoluto), não há
   * dir sob nossa gestão para orfanar, então o registro é removido.
   */
  async destroy(envId: string): Promise<void> {
    const env = await this.prisma.clientEnvironment.findUnique({ where: { id: envId } })
    if (env?.path) {
      // Contenção pelo idioma canônico de path.relative (mesma razão do
      // repoPathInEnv: é o que o CodeQL reconhece como sanitizador). Só apaga
      // ESTRITAMENTE DENTRO da raiz de ambientes: rel === '' (o próprio
      // baseDir — apagaria os ambientes de TODOS os clientes de uma vez),
      // '..' (fora) e absoluto (outro volume) são todos barrados.
      const resolved = path.resolve(env.path)
      const root = path.resolve(this.baseDir)
      const rel = path.relative(root, resolved)
      if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        try {
          await fs.rm(resolved, { recursive: true, force: true })
        } catch (err) {
          // rm falhou: NÃO deleta o registro. Deixa o GC reencontrar o dir
          // (com a credencial) pela linha do banco e retentar no próximo tick.
          console.warn(
            '[environment] destroy: rm do dir falhou, registro preservado para o GC retentar',
            { envId, error: err instanceof Error ? err.message : String(err) }
          )
          return
        }
      }
    }
    await this.prisma.clientEnvironment.delete({ where: { id: envId } }).catch(() => undefined)
  }

  /**
   * Fixa o ambiente provisório do usuário no aceite final (passo 10): vira
   * 'fixed' (permanente) e sai do alcance da faxina 24h — agora é um cliente.
   * Idempotente: updateMany não falha se não houver provisional.
   */
  async fix(userId: string): Promise<void> {
    // Dedup ANTES de fixar: se uma corrida deixou >1 provisional, fixar todos
    // tornaria o duplicado (vazio, com credencial em disco) permanente e fora
    // do alcance da faxina 24h — lixo com segredo pra sempre. Mantém só o mais
    // recente (o canônico do findFirst desc, onde clone e login aconteceram) e
    // destrói os demais (dir + registro).
    const provisionals = await this.prisma.clientEnvironment.findMany({
      where: { userId, status: 'provisional' },
      orderBy: { createdAt: 'desc' },
    })
    for (const dupe of provisionals.slice(1)) {
      await this.destroy(dupe.id)
    }

    await this.prisma.clientEnvironment.updateMany({
      where: { userId, status: 'provisional' },
      data: { status: 'fixed', fixedAt: new Date() },
    })
  }

  /**
   * Instala os recursos VERSIONADOS do manifesto (motores + referência dos
   * pacotes nativos) DENTRO do ambiente `envId`, rodando o script de bootstrap
   * (privado, `GITORCH_BOOTSTRAP_SCRIPT`) e lendo de volta o
   * `<env>/.gitorch/env-lock.json` que ele gera — o registro auditável do que
   * foi REALMENTE instalado, gravado em `resourcesLock`.
   *
   * Honestidade acima de tudo: o ambiente vira 'provisioning' antes de rodar
   * e só chega a 'ready' quando o script sai com sucesso E o env-lock existe
   * e é um JSON válido. QUALQUER desvio disso (script falhou, timeout, env
   * var ausente, env-lock ausente/corrompido) marca 'error' com a causa REAL
   * — nunca deixa o ambiente "pronto" sem os recursos de fato instalados
   * (o dono não aceita um "concluído" fingido). TUDO isso é escrito em
   * `resourcesStatus`, NUNCA em `status` (ver o comentário da classe acima) —
   * o ciclo de vida do wizard é assunto de outro método (fix/createProvisional).
   *
   * Assíncrono do ponto de vista de quem chama (não lança: falhas viram um
   * resultado `{ ok: false, error }`), pensado para ser dado como
   * fire-and-forget pela rota (não trava a resposta HTTP) — o progresso real
   * fica em `resourcesStatus`, lido por quem consulta o ambiente (GET
   * /setup/status).
   *
   * Guard de reentrância: esta função dispara tanto no CLONE (passo 4/5,
   * cedo) quanto no SUBMIT (passo 10, salvaguarda) — ver routes/setup.ts. Sem
   * o guard, o 2º disparo para o MESMO ambiente rodaria o script de bootstrap
   * em paralelo com o 1º — dois processos escrevendo env-lock.json ao mesmo
   * tempo, uma corrida real. 'ready' devolve o resultado já conhecido (sem
   * rodar de novo); 'provisioning' devolve erro sem tocar em nada (a chamada
   * em andamento é quem decide o resultado final).
   */
  async bootstrapResources(envId: string): Promise<BootstrapResourcesResult> {
    const env = await this.prisma.clientEnvironment.findUnique({ where: { id: envId } })
    if (!env?.path) {
      console.warn('[environment] bootstrapResources: ambiente inexistente ou sem path', { envId })
      return { ok: false, error: 'ambiente não encontrado' }
    }

    if (env.resourcesStatus === 'ready') {
      return { ok: true, lock: env.resourcesLock }
    }
    if (env.resourcesStatus === 'provisioning') {
      return { ok: false, error: 'bootstrap já em andamento' }
    }

    await this.prisma.clientEnvironment.update({
      where: { id: envId },
      data: { resourcesStatus: 'provisioning' },
    })

    try {
      const result = await this.bootstrapRunner(env.path)
      if (result.exitCode !== 0) {
        const cause = result.stderr.trim() || `bootstrap-env.sh saiu com código ${result.exitCode}`
        return await this.markBootstrapError(envId, cause)
      }

      const lockPath = path.join(env.path, '.gitorch', 'env-lock.json')
      let raw: string
      try {
        raw = await fs.readFile(lockPath, 'utf8')
      } catch (err) {
        const cause = `env-lock.json não foi gerado pelo bootstrap (${lockPath}): ${
          err instanceof Error ? err.message : String(err)
        }`
        return await this.markBootstrapError(envId, cause)
      }

      let lock: unknown
      try {
        lock = JSON.parse(raw)
      } catch (err) {
        const cause = `env-lock.json inválido em ${lockPath}: ${
          err instanceof Error ? err.message : String(err)
        }`
        return await this.markBootstrapError(envId, cause)
      }

      await this.prisma.clientEnvironment.update({
        where: { id: envId },
        data: { resourcesStatus: 'ready', resourcesLock: lock as Prisma.InputJsonValue },
      })
      return { ok: true, lock }
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err)
      return await this.markBootstrapError(envId, cause)
    }
  }

  /** Marca resourcesStatus 'error' com a causa REAL e loga — nunca some com o motivo. */
  private async markBootstrapError(
    envId: string,
    cause: string
  ): Promise<BootstrapResourcesResult> {
    console.warn('[environment] bootstrapResources falhou — ambiente marcado error', {
      envId,
      cause,
    })
    await this.prisma.clientEnvironment.update({
      where: { id: envId },
      data: { resourcesStatus: 'error' },
    })
    return { ok: false, error: cause }
  }
}
