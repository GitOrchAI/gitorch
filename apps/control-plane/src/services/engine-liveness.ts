import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { MODEL_DISCOVERERS, type ModelDiscoverer } from './model-catalog.js'
import { QUOTA_READERS, type QuotaReader, type QuotaReading } from './quota-reader.js'

const execFileAsync = promisify(execFile)

// Validador "hello-world" dos motores: roda UM comando barato e READ-ONLY que
// prova que o motor está VIVO e AUTENTICADO — sem gastar quota de LLM. É o anti-
// fachada: nada aqui presume que o motor está conectado; a prova é o exit code de
// um comando de verdade.
//
// Nível REAL de cada comando (observado rodando de verdade nesta VM, logado e com
// um HOME vazio para simular deslogado):
//
//   antigravity → `agy models`
//     logado:   exit 0 + a lista de modelos (uma por linha).
//     deslogado: exit 1 + "Please sign in to view available models".
//     → prova autenticação E entrega a lista de modelos de brinde. Não gasta LLM.
//
//   codex → `codex login status`
//     logado:   exit 0 + "Logged in using ChatGPT".
//     deslogado: exit 1 + "Not logged in".
//     → prova login diretamente. Não gasta LLM.
//
//   claude → `claude auth status`
//     logado:   exit 0 + {"loggedIn": true, ...}.
//     deslogado: exit 1 + {"loggedIn": false, "authMethod": "none"}.
//     → prova autenticação de verdade. Não gasta LLM.
//     Importante: NÃO usamos `claude doctor`. Ele checa só a saúde do auto-updater
//     (não a autenticação) e abre uma TUI interativa que TRAVA sem terminal —
//     seria uma fachada de liveness. `claude auth status` é o comando honesto.
//
// Contrato uniforme: exit 0 = vivo; exit != 0 ou timeout = não-vivo (com `error`
// sanitizado, sem vazar credencial). models e quota são BEST-EFFORT: só coletados
// quando o motor está vivo e uma falha neles nunca derruba `alive`.

const LIVENESS_TIMEOUT_MS = 30_000
const MAX_BUFFER = 4 * 1024 * 1024

/** Runner injetável (execFile real por padrão; fake nos testes). Resolve quando o
 *  processo sai com exit 0; rejeita em exit != 0, timeout ou binário ausente. */
export type LivenessRunner = (
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv
) => Promise<string>

export interface LivenessResult {
  alive: boolean
  models: string[]
  quota: QuotaReading
  error?: string
}

export interface CheckLivenessDeps {
  runner?: LivenessRunner
  discoverers?: Record<string, ModelDiscoverer>
  quotaReaders?: Record<string, QuotaReader>
}

interface LivenessCommand {
  bin: string
  args: string[]
}

/** Comando de liveness por runtime, com o bin sobrescrevível por ambiente. Lido a
 *  cada chamada para respeitar overrides de GITORCH_*_BIN sem redeploy. */
function livenessCommandFor(runtime: string): LivenessCommand | undefined {
  switch (runtime) {
    case 'antigravity':
      return { bin: process.env['GITORCH_AGY_BIN'] ?? 'agy', args: ['models'] }
    case 'codex':
      return { bin: process.env['GITORCH_CODEX_BIN'] ?? 'codex', args: ['login', 'status'] }
    case 'claude':
      return { bin: process.env['GITORCH_CLAUDE_BIN'] ?? 'claude', args: ['auth', 'status'] }
    default:
      return undefined
  }
}

const emptyQuota = (): QuotaReading => ({ remaining: null, total: null })

/**
 * Verifica se `runtime` está vivo/autenticado rodando o comando de liveness real
 * dentro de `homeDir` (o HOME materializado do dono). Best-effort para models e
 * quota. Nunca lança: qualquer falha vira `{ alive: false, error }`.
 */
export async function checkLiveness(
  runtime: string,
  homeDir: string,
  deps: CheckLivenessDeps = {}
): Promise<LivenessResult> {
  const command = livenessCommandFor(runtime)
  if (!command) {
    return {
      alive: false,
      models: [],
      quota: emptyQuota(),
      error: `motor sem comando de liveness definido: ${runtime}`,
    }
  }

  const runner = deps.runner ?? defaultLivenessRunner
  try {
    const env = await buildLivenessEnv(homeDir)
    await runner(command.bin, command.args, env)
  } catch (err) {
    return { alive: false, models: [], quota: emptyQuota(), error: sanitizeError(err) }
  }

  // Vivo. models e quota são coletados agora, mas são secundários: engolimos
  // qualquer erro (lista vazia / quota nula) para nunca derrubar `alive`.
  //
  // Object.hasOwn (não indexação direta [runtime]): discoverers/quotaReaders
  // são objetos-literais comuns, que herdam de Object.prototype. Embora
  // `runtime` já tenha passado pelo switch de `livenessCommandFor` acima (só
  // chegamos aqui com 'antigravity'|'codex'|'claude'), o CodeQL não modela essa
  // correlação de controle-de-fluxo e sinaliza a indexação como "unvalidated
  // dynamic method call" (achado real do scanner) — o guard explícito fecha o
  // alerta e documenta a invariante, sem depender de o leitor inferir o switch.
  const discoverers = deps.discoverers ?? MODEL_DISCOVERERS
  const quotaReaders = deps.quotaReaders ?? QUOTA_READERS
  const discover = Object.hasOwn(discoverers, runtime) ? discoverers[runtime] : undefined
  const readQuota = Object.hasOwn(quotaReaders, runtime) ? quotaReaders[runtime] : undefined
  const models = discover ? await discover(homeDir).catch(() => [] as string[]) : []
  const quota = readQuota ? await readQuota(homeDir).catch(() => emptyQuota()) : emptyQuota()
  return { alive: true, models, quota }
}

/**
 * Monta o ambiente do processo filho: PATH, HOME=homeDir, XDG_RUNTIME_DIR (se
 * existir — o agy trava no socket do language-server sem ele) e, crucialmente,
 * cada arquivo de `<homeDir>/.gitorch/env/*` como variável de ambiente (ex.:
 * CLAUDE_CODE_OAUTH_TOKEN). É o mesmo laço do entrypoint.sh da imagem do agente e
 * de createLocalCredentialRunner em plugins/scheduler.ts — sem ele o `claude` não
 * enxerga o token materializado e reportaria não-vivo por engano.
 */
async function buildLivenessEnv(homeDir: string): Promise<Record<string, string>> {
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: homeDir }
  if (process.env['XDG_RUNTIME_DIR']) env['XDG_RUNTIME_DIR'] = process.env['XDG_RUNTIME_DIR']

  const envDir = path.join(homeDir, '.gitorch', 'env')
  const names = await fs.readdir(envDir).catch(() => [] as string[])
  for (const name of names) {
    const value = await fs.readFile(path.join(envDir, name), 'utf8').catch(() => null)
    if (value !== null) env[name] = value.trim()
  }
  return env
}

const defaultLivenessRunner: LivenessRunner = async (bin, args, env) => {
  const pending = execFileAsync(bin, args, {
    env,
    timeout: LIVENESS_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  })
  // O agy lê o stdin antes de responder; sem EOF ele trava. Fechar sinaliza o EOF.
  pending.child.stdin?.end()
  const { stdout } = await pending
  return stdout
}

// Segredos possíveis num stderr: NOME_COM_TOKEN=valor e tokens longos soltos.
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*\S+/gi
const LONG_TOKEN = /\b[A-Za-z0-9_-]{24,}\b/g

/** Redige credenciais de um texto antes de expô-lo em `error` ou log. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_ASSIGNMENT, '$1=***').replace(LONG_TOKEN, '***')
}

/** Traduz a falha do runner numa mensagem curta, categorizada e sem credencial. */
function sanitizeError(err: unknown): string {
  const e = (err ?? {}) as {
    code?: string | number | null
    killed?: boolean
    signal?: string | null
    stderr?: unknown
    message?: unknown
  }
  if (e.code === 'ENOENT') return 'binário do motor não encontrado no PATH'
  if (e.killed || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT') {
    return `sem resposta em ${LIVENESS_TIMEOUT_MS / 1000}s (timeout)`
  }
  const raw =
    (typeof e.stderr === 'string' && e.stderr.trim()) ||
    (typeof e.message === 'string' && e.message.trim()) ||
    'comando de liveness falhou'
  const firstLine = raw.split('\n')[0] ?? raw
  return redactSecrets(firstLine).slice(0, 200)
}
