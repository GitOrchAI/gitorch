import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { decryptCredential, encryptCredential } from '../lib/credential-crypto.js'
import { archivePaths, readArchiveEntry, restoreDirectory } from '../lib/credential-archive.js'
import { MODEL_DISCOVERERS } from './model-catalog.js'
import { QUOTA_READERS } from './quota-reader.js'
import { checkLiveness, type LivenessResult } from './engine-liveness.js'

// Runtimes suportados e os CAMINHOS de credencial de cada um, relativos ao HOME.
// Apenas os arquivos de token/config — NÃO o diretório inteiro (históricos e
// caches dos motores chegam a gigabytes). Configurável por ambiente
// (GITORCH_ENGINE_CRED_PATHS, JSON runtime->string[]) para novos motores sem
// mexer no código. Fonte única de verdade.
const DEFAULT_CREDENTIAL_PATHS: Record<string, string[]> = {
  antigravity: ['.gemini/antigravity-cli/antigravity-oauth-token'],
  // models_cache.json é o catálogo de modelos do Codex (atualizado no login);
  // vai junto para a descoberta de modelos funcionar. Ausência é tolerada.
  codex: ['.codex/auth.json', '.codex/models_cache.json'],
  // .claude/.credentials.json cobre o login interativo (/login); o wizard usa
  // o fluxo real de `claude setup-token` (token colado, sem UI web possível
  // pro provider) — esse token vira uma variável de ambiente, não um arquivo
  // de config do CLI, então mora em .gitorch/env/ (mesmo entrypoint que já
  // exporta .gitorch/gh-token como GH_TOKEN faz o mesmo para qualquer arquivo
  // aqui — ver scripts/infra/agent-image/entrypoint.sh).
  claude: ['.claude/.credentials.json', '.gitorch/env/CLAUDE_CODE_OAUTH_TOKEN'],
  // As "mãos" dos agentes no GitHub: um token (fine-grained PAT hoje; token de
  // GitHub App no futuro) que a missão recebe como GH_TOKEN dentro do sandbox.
  // Mesmo ciclo de vida das credenciais de motor: cifrado por usuário,
  // materializado por missão, nunca exposto no host.
  github: ['.gitorch/gh-token'],
}

export const ENGINE_CREDENTIAL_PATHS: Record<string, string[]> = (() => {
  const raw = process.env['GITORCH_ENGINE_CRED_PATHS']
  if (!raw) return DEFAULT_CREDENTIAL_PATHS
  try {
    return { ...DEFAULT_CREDENTIAL_PATHS, ...(JSON.parse(raw) as Record<string, string[]>) }
  } catch {
    return DEFAULT_CREDENTIAL_PATHS
  }
})()

// Object.hasOwn (não `runtime in ENGINE_CREDENTIAL_PATHS`, não `!map[runtime]`):
// ENGINE_CREDENTIAL_PATHS é um objeto-literal comum, que herda de
// Object.prototype. `runtime` vem de input do cliente (params de rota) sem
// tipo restrito — um valor como 'constructor'/'toString'/'hasOwnProperty'
// resolveria para uma função HERDADA do protótipo (verdadeira em `in` e em
// checagem de falsy), não para `undefined`, escapando do guard "não suportado"
// e sendo usada como se fosse config/função real de motor mais adiante —
// achado real do CodeQL (unvalidated dynamic method call), consertado em
// TODOS os lookups deste arquivo, não só nos apontados pelo scanner.
export function isSupportedRuntime(runtime: string): boolean {
  return Object.hasOwn(ENGINE_CREDENTIAL_PATHS, runtime)
}

// Alias de nome comercial -> id de runtime real: o wizard/frontend usa
// 'claude-code' (nome de produto), mas o runtime de execução (F6AgentRuntime
// e as chaves acima) é 'claude'. Fonte ÚNICA — toda rota que recebe um id de
// motor vindo do cliente (setup/submit, POST /engines/:runtime/token) resolve
// por aqui, senão os dois vocabulários divergem silenciosamente (já
// aconteceu: setup/submit reconhecia 'claude-code' e a rota de token não).
const ENGINE_ID_ALIASES: Record<string, string> = {
  'claude-code': 'claude',
}

export function resolveEngineId(id: string): string {
  return ENGINE_ID_ALIASES[id] ?? id
}

type PrismaLike = Pick<PrismaClient, 'engineConnection'>

export interface ConnectionStatus {
  runtime: string
  status: string
  modelsRefreshedAt: Date | null
  lastValidatedAt: Date | null
  lastError: string | null
  models: string[]
  quotaRemaining: number | null
  quotaTotal: number | null
}

type LivenessChecker = (runtime: string, homeDir: string) => Promise<LivenessResult>

export class EngineConnectionService {
  private readonly liveness: LivenessChecker

  constructor(
    private readonly prisma: PrismaLike,
    livenessImpl: LivenessChecker = (runtime, homeDir) => checkLiveness(runtime, homeDir)
  ) {
    this.liveness = livenessImpl
  }

  /**
   * Cria um HOME temporário 0700 (com `subdir` já criado dentro dele),
   * executa `fn` ali, e garante a limpeza mesmo se `fn` lançar — inclusive se
   * a própria limpeza falhar (senão um erro no `rm` mascararia o erro
   * original de `fn`, que é o que o `finally` bruto de antes fazia). Um único
   * caminho para as 4 cópias quase idênticas de "temp dir -> trabalho ->
   * limpeza" que existiam antes (connectGitHubToken, connectRawToken,
   * connectFileCredential, refreshModels).
   */
  private async withTempHome<T>(
    prefix: string,
    subdir: string,
    fn: (home: string) => Promise<T>
  ): Promise<T> {
    const home = path.join(os.tmpdir(), `gitorch-${prefix}-${randomUUID()}`)
    await fs.mkdir(path.join(home, subdir), { recursive: true, mode: 0o700 })
    try {
      return await fn(home)
    } finally {
      await fs.rm(home, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * Captura a credencial atual de um motor a partir de um HOME (onde o login do
   * CLI foi concluído), cifra e guarda para o usuário. É o passo que transforma
   * um login em uma conexão persistente e portável do cliente.
   */
  async captureFromHome(
    userId: string,
    runtime: string,
    homeDir: string,
    extra?: { credentialKind?: 'file' | 'env'; envVarName?: string; expiresAt?: Date }
  ): Promise<ConnectionStatus> {
    const relPaths = Object.hasOwn(ENGINE_CREDENTIAL_PATHS, runtime)
      ? ENGINE_CREDENTIAL_PATHS[runtime]
      : undefined
    if (!relPaths) throw new Error(`Runtime não suportado: ${runtime}`)

    const blob = await archivePaths(homeDir, relPaths)
    if (!blob) {
      throw new Error(
        `Credencial de ${runtime} não encontrada em ${homeDir} (${relPaths.join(', ')}); o login foi concluído?`
      )
    }

    const encryptedCredential = encryptCredential(blob)
    const now = new Date()
    const extraFields = {
      ...(extra?.credentialKind ? { credentialKind: extra.credentialKind } : {}),
      ...(extra?.envVarName ? { envVarName: extra.envVarName } : {}),
      ...(extra?.expiresAt ? { expiresAt: extra.expiresAt } : {}),
    }

    // Validação viva (anti-fachada): prova que o motor está autenticado rodando
    // um comando real ANTES de marcar 'connected'. github NÃO é motor — não tem
    // liveness, então mantém o comportamento anterior. A credencial acabou de
    // ser arquivada do homeDir e ainda está lá; validamos no mesmo lugar.
    const liveness = runtime === 'github' ? null : await this.liveness(runtime, homeDir)
    const statusFields = buildStatusFields(liveness, now)

    const record = await this.prisma.engineConnection.upsert({
      where: { userId_runtime: { userId, runtime } },
      update: { encryptedCredential, ...statusFields, ...extraFields },
      create: { userId, runtime, encryptedCredential, ...statusFields, ...extraFields },
    })
    return toStatus(record)
  }

  /**
   * Conecta o GitHub do usuário a partir de um token (fine-grained PAT). O
   * token vira o arquivo `.gitorch/gh-token` num HOME temporário e segue o
   * MESMO caminho de qualquer credencial (cifra → EngineConnection) — nenhuma
   * rota especial de armazenamento.
   */
  async connectGitHubToken(userId: string, token: string): Promise<ConnectionStatus> {
    const trimmed = token.trim()
    // Formato de token do GitHub: um único token não vazio, sem espaços/quebras
    // (cobre github_pat_*, ghp_* e tokens de App). Não logamos o valor nunca.
    if (!trimmed || /\s/.test(trimmed)) {
      throw new Error('token do GitHub inválido: vazio ou com espaços')
    }
    return this.withTempHome('gh', '.gitorch', async (home) => {
      await fs.writeFile(path.join(home, '.gitorch', 'gh-token'), trimmed, { mode: 0o600 })
      return await this.captureFromHome(userId, 'github', home)
    })
  }

  /**
   * Conecta um motor via token colado que o próprio provider não expõe como
   * arquivo de config do CLI (ex.: `claude setup-token`, que gera um valor
   * pra usar como variável de ambiente, não um `.credentials.json`). O token
   * vira um arquivo em `.gitorch/env/<envVarName>` — o entrypoint da missão
   * exporta qualquer arquivo ali como env var do mesmo nome (mesma lógica já
   * usada para `.gitorch/gh-token` → GH_TOKEN).
   */
  async connectRawToken(
    userId: string,
    runtime: string,
    token: string,
    options: { envVarName: string; expiresAt?: Date }
  ): Promise<ConnectionStatus> {
    const trimmed = token.trim()
    if (!trimmed || /\s/.test(trimmed)) {
      throw new Error(`token de ${runtime} inválido: vazio ou com espaços`)
    }
    // Hoje o único chamador (plugins/engines.ts) passa um valor fixo, mas o
    // método em si não tinha guard nenhum: um envVarName tipo '../../etc/cron.d/evil'
    // faria o writeFile abaixo escrever fora de .gitorch/env, no filesystem do host.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.envVarName)) {
      throw new Error(`envVarName inválido: ${options.envVarName}`)
    }
    return this.withTempHome('envtoken', path.join('.gitorch', 'env'), async (home) => {
      await fs.writeFile(path.join(home, '.gitorch', 'env', options.envVarName), trimmed, {
        mode: 0o600,
      })
      return await this.captureFromHome(userId, runtime, home, {
        credentialKind: 'env',
        envVarName: options.envVarName,
        ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      })
    })
  }

  /**
   * Conecta um motor colando o CONTEÚDO do arquivo de credencial que o login
   * local do CLI já produziu (ex.: `~/.codex/auth.json` do Codex,
   * `~/.gemini/antigravity-cli/antigravity-oauth-token` do Antigravity) —
   * o caminho oficial de "logar localmente e transferir o arquivo" quando não
   * há fluxo headless completo no servidor. Escreve no caminho PRIMÁRIO
   * (primeira entrada) de ENGINE_CREDENTIAL_PATHS do runtime.
   */
  async connectFileCredential(
    userId: string,
    runtime: string,
    content: string
  ): Promise<ConnectionStatus> {
    const relPaths = Object.hasOwn(ENGINE_CREDENTIAL_PATHS, runtime)
      ? ENGINE_CREDENTIAL_PATHS[runtime]
      : undefined
    if (!relPaths) throw new Error(`Runtime não suportado: ${runtime}`)
    if (!content.trim()) throw new Error(`credencial de ${runtime} vazia`)

    const primaryPath = relPaths[0] as string
    // Validação mínima de FORMATO antes de marcar como 'connected' — sem isto,
    // qualquer string colada virava uma credencial "válida" e o problema só
    // aparecia depois, opaco, quando uma missão tentasse usar o motor de
    // verdade. auth.json do Codex é JSON por definição; o token do
    // Antigravity não tem formato documentado no código, então só a checagem
    // de vazio acima se aplica a ele.
    if (primaryPath.endsWith('.json')) {
      try {
        JSON.parse(content)
      } catch {
        throw new Error(`credencial de ${runtime} inválida: esperado JSON em ${primaryPath}`)
      }
    }
    return this.withTempHome('filecred', path.dirname(primaryPath), async (home) => {
      await fs.writeFile(path.join(home, primaryPath), content, { mode: 0o600 })
      return await this.captureFromHome(userId, runtime, home)
    })
  }

  /**
   * Restaura a credencial cifrada do usuário para dentro de `homeDir`, para uma
   * missão usar o motor como aquele cliente. Retorna false se não há conexão.
   */
  async materializeToHome(userId: string, runtime: string, homeDir: string): Promise<boolean> {
    const record = await this.prisma.engineConnection.findUnique({
      where: { userId_runtime: { userId, runtime } },
    })
    if (!record?.encryptedCredential || record.status !== 'connected') return false
    if (!Object.hasOwn(ENGINE_CREDENTIAL_PATHS, runtime)) return false
    // expiresAt existe desde 151b471 mas nada nunca checava — uma missão
    // continuava materializando um token vencido silenciosamente até o CLI
    // falhar a autenticação lá dentro, em vez do control plane detectar aqui.
    if (record.expiresAt && record.expiresAt.getTime() < Date.now()) return false

    // O blob guarda caminhos relativos ao HOME; restaura na raiz do HOME alvo.
    const blob = decryptCredential(record.encryptedCredential)
    await restoreDirectory(blob, homeDir)
    return true
  }

  /**
   * Lê o token do GitHub do usuário em texto puro, para chamadas server-side
   * à API do GitHub (ex.: listar repos no wizard). Lê o blob decifrado
   * direto em memória (readArchiveEntry) — nunca grava nada no disco do
   * host. Retorna null se não há conexão.
   */
  async getRawGithubToken(userId: string): Promise<string | null> {
    const record = await this.prisma.engineConnection.findUnique({
      where: { userId_runtime: { userId, runtime: 'github' } },
    })
    if (!record?.encryptedCredential || record.status !== 'connected') return null
    const blob = decryptCredential(record.encryptedCredential)
    const token = readArchiveEntry(blob, '.gitorch/gh-token')
    return token?.trim() ?? null
  }

  async list(userId: string): Promise<ConnectionStatus[]> {
    const records = await this.prisma.engineConnection.findMany({ where: { userId } })
    return records.map(toStatus)
  }

  /**
   * Descobre o catálogo de modelos do provider usando a credencial do usuário e
   * o guarda em EngineConnection.models. Roda num HOME temporário isolado.
   * Retorna a lista descoberta (vazia se não há descoberta para o runtime).
   */
  async refreshModels(userId: string, runtime: string): Promise<string[]> {
    const discover = Object.hasOwn(MODEL_DISCOVERERS, runtime)
      ? MODEL_DISCOVERERS[runtime]
      : undefined
    if (!discover) return []

    return this.withTempHome('models', '.', async (home) => {
      try {
        const materialized = await this.materializeToHome(userId, runtime, home)
        if (!materialized) return []
        const models = await discover(home)
        // Descoberta vazia NÃO sobrescreve um catálogo bom anterior nem finge que
        // "atualizou": registra o sinal e preserva o catálogo existente.
        if (models.length === 0) {
          await this.prisma.engineConnection.updateMany({
            where: { userId, runtime },
            data: { lastError: 'catálogo de modelos veio vazio na última tentativa' },
          })
          return []
        }
        // Junto com os modelos, lê a quota restante do provider (best-effort): o
        // spend-guard usa isso para não estourar a conta do cliente (BYOK).
        const readQuota = Object.hasOwn(QUOTA_READERS, runtime) ? QUOTA_READERS[runtime] : undefined
        const quota = readQuota
          ? await readQuota(home).catch(() => ({ remaining: null, total: null }))
          : { remaining: null, total: null }
        await this.prisma.engineConnection.updateMany({
          where: { userId, runtime },
          data: {
            models,
            modelsRefreshedAt: new Date(),
            lastError: null,
            quotaRemaining: quota.remaining,
            quotaTotal: quota.total,
            quotaRefreshedAt: new Date(),
          },
        })
        return models
      } catch {
        // Descoberta é best-effort: falha num provider não afeta os demais nem a
        // conexão. O catálogo anterior (se houver) permanece.
        return []
      }
    })
  }

  async revoke(userId: string, runtime: string): Promise<void> {
    await this.prisma.engineConnection.updateMany({
      where: { userId, runtime },
      data: { status: 'revoked', encryptedCredential: null },
    })
  }
}

function toStatus(record: {
  runtime: string
  status: string
  modelsRefreshedAt: Date | null
  lastValidatedAt: Date | null
  lastError: string | null
  models?: unknown
  quotaRemaining?: number | null
  quotaTotal?: number | null
}): ConnectionStatus {
  return {
    runtime: record.runtime,
    status: record.status,
    modelsRefreshedAt: record.modelsRefreshedAt,
    lastValidatedAt: record.lastValidatedAt,
    lastError: record.lastError,
    models: Array.isArray(record.models) ? (record.models as string[]) : [],
    quotaRemaining: record.quotaRemaining ?? null,
    quotaTotal: record.quotaTotal ?? null,
  }
}

/**
 * Traduz o resultado da validação viva nos campos de status/models/quota do
 * upsert. Sem liveness (github ou runtime sem comando) preserva o comportamento
 * anterior ('connected'). Vivo grava models+quota no mesmo passo. Não-vivo marca
 * 'error' com o motivo real e NÃO atualiza lastValidatedAt (não mente validação),
 * mantendo a credencial cifrada guardada para reconectar sem recolar.
 */
function buildStatusFields(liveness: LivenessResult | null, now: Date): Record<string, unknown> {
  if (liveness === null) {
    return { status: 'connected', lastValidatedAt: now, lastError: null }
  }
  if (liveness.alive) {
    return {
      status: 'connected',
      lastValidatedAt: now,
      lastError: null,
      models: liveness.models,
      modelsRefreshedAt: now,
      quotaRemaining: liveness.quota.remaining,
      quotaTotal: liveness.quota.total,
      quotaRefreshedAt: now,
    }
  }
  return {
    status: 'error',
    lastError: liveness.error ?? 'motor não respondeu à validação viva',
  }
}
