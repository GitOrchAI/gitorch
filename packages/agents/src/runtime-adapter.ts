import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentRuntimeSelection, F6AgentRuntime, RuntimeCredentialRef } from './types'

const execFileAsync = promisify(execFile)

export interface RuntimeExecutionRequest {
  missionId: string
  prompt: string
  runtime: AgentRuntimeSelection
  credentialRef: RuntimeCredentialRef
  /** Diretório de trabalho da missão (workspace alocado). */
  cwd?: string
  /** Mata o processo do agente após N ms (guarda contra missão pendurada). */
  timeoutMs?: number
}

export interface RuntimeExecutionResult {
  missionId: string
  runtime: F6AgentRuntime
  output: string
  stderr: string
  exitCode: number
  durationMs: number
}

export interface RuntimeCommandRequest {
  binary: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  /** Mata o processo após N ms (evita missão pendurada segurando RAM). */
  timeoutMs?: number
  /**
   * Conteúdo escrito no stdin do processo (depois fechado com EOF). Usado para
   * entregar o PROMPT ao Antigravity CLI: em modo --print o agy lê a tarefa do
   * stdin; passar o prompt como argumento posicional com o stdin vazio faz o
   * motor "fixar" nas próprias flags de CLI (--sandbox/--print-timeout) como se
   * fossem a missão. Quando ausente, o stdin é fechado imediatamente (EOF).
   */
  stdin?: string
}

/**
 * Ambiente mínimo repassado ao processo do agente.
 *
 * NUNCA herdar `process.env` inteiro: o control plane carrega DATABASE_URL,
 * JWT_SECRET, tokens do GitHub/Telegram etc., e o agente é um CLI dirigido por
 * modelo operando sobre conteúdo de repositório de terceiros (risco de prompt
 * injection exfiltrar segredos). Só passamos o essencial para o CLI rodar e
 * achar suas próprias credenciais OAuth (em ~/.gemini, ~/.codex, ~/.claude).
 */
export function buildChildProcessEnv(extra: Record<string, string>): Record<string, string> {
  const allow = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'TERM',
    'TMPDIR',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    // Necessário para CLIs que abrem socket de serviço interno (ex.: o
    // language-server do Antigravity CLI bloqueia na ausência desta variável).
    'XDG_RUNTIME_DIR',
  ]
  const base: Record<string, string> = {}
  for (const key of allow) {
    const value = process.env[key]
    if (value !== undefined) {
      base[key] = value
    }
  }
  return { ...base, ...extra }
}

function normalizeExitCode(code: unknown): number {
  return typeof code === 'number' ? code : 1
}

export interface RuntimeCommandResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

export type RuntimeCommandRunner = (
  request: RuntimeCommandRequest
) => Promise<RuntimeCommandResult> | RuntimeCommandResult

export const realRuntimeCommandRunner: RuntimeCommandRunner = async (request) => {
  const start = Date.now()
  try {
    const pending = execFileAsync(request.binary, request.args, {
      env: buildChildProcessEnv(request.env),
      cwd: request.cwd,
      // Saída de CLIs agênticos pode passar do 1MB default do execFile.
      maxBuffer: 16 * 1024 * 1024,
      // Processo pendurado é morto (SIGKILL) para não reter memória do host.
      timeout: request.timeoutMs,
      killSignal: 'SIGKILL',
    })
    // CLIs agênticos em modo não-interativo leem o stdin até o EOF antes de
    // iniciar; o execFile mantém o pipe aberto, o que bloquearia o processo
    // indefinidamente. Escrevemos o prompt (quando entregue por stdin) e sempre
    // fechamos o stdin para sinalizar o EOF imediatamente.
    if (request.stdin !== undefined) {
      pending.child.stdin?.write(request.stdin)
    }
    pending.child.stdin?.end()
    const { stdout, stderr } = await pending
    return {
      exitCode: 0,
      stdout,
      stderr,
      durationMs: Date.now() - start,
    }
  } catch (error: unknown) {
    const err = error as {
      code?: number | string
      killed?: boolean
      signal?: string
      stdout?: string
      stderr?: string
      message?: string
    }
    // Timeout mata com SIGKILL: reporta como falha explícita, nunca sucesso.
    const timedOut = err.killed === true || err.signal === 'SIGKILL'
    return {
      exitCode: timedOut ? 124 : normalizeExitCode(err.code),
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || String(error),
      durationMs: Date.now() - start,
    }
  }
}

export interface RuntimeAdapter {
  runtime: F6AgentRuntime
  run(request: RuntimeExecutionRequest): Promise<RuntimeExecutionResult>
}

export class RuntimeRegistry {
  private readonly adapters = new Map<F6AgentRuntime, RuntimeAdapter>()

  register(adapter: RuntimeAdapter): void {
    this.adapters.set(adapter.runtime, adapter)
  }

  resolve(runtime: F6AgentRuntime): RuntimeAdapter {
    const adapter = this.adapters.get(runtime)

    if (!adapter) {
      throw new Error(`No runtime adapter registered for ${runtime}`)
    }

    return adapter
  }
}

export function buildRuntimeEnvironment(ref: RuntimeCredentialRef): Record<string, string> {
  const env: Record<string, string> = {
    GITORCH_RUNTIME_CONNECTION_ID: ref.connectionId,
    GITORCH_RUNTIME_OWNER_SCOPE: ref.ownerScope,
    GITORCH_RUNTIME: ref.runtime,
    GITORCH_PROVIDED_SECRETS: ref.providedSecrets.join(','),
  }
  if (ref.ownerUserId) {
    env['GITORCH_OWNER_USER_ID'] = ref.ownerUserId
  }
  return env
}

export interface CreateCliRuntimeAdapterOptions {
  runtime: F6AgentRuntime
  binary: string
  args?: string[]
  runner?: RuntimeCommandRunner
  /** Nome da flag de modelo do CLI (ex.: '--model'); quando presente, o modelo da missão vira argumento. */
  modelArgName?: string
  /**
   * Nome da flag que escopa o CLI ao diretório da missão (ex.: '--add-dir').
   * Sem isso o Antigravity CLI analisa o "projeto ativo" dele, não o workspace
   * clonado da missão. Só é aplicada quando request.cwd está presente.
   */
  workspaceDirArgName?: string
  /**
   * Separador inserido antes do prompt (ex.: '--'). Necessário para CLIs cujas
   * flags variádicas (listas de valores) engoliriam o prompt posicional.
   */
  promptSeparator?: string
  /**
   * Entrega o prompt pelo STDIN em vez de argumento posicional. Obrigatório para
   * o Antigravity CLI (`agy --print`): ele lê a tarefa do stdin; com o stdin
   * vazio ele trata as próprias flags como a missão. Ver RuntimeCommandRequest.stdin.
   */
  promptViaStdin?: boolean
}

export function createCliRuntimeAdapter(options: CreateCliRuntimeAdapterOptions): RuntimeAdapter {
  const runner = options.runner ?? realRuntimeCommandRunner

  const baseArgs = [...(options.args ?? [])]

  return {
    runtime: options.runtime,
    async run(request: RuntimeExecutionRequest) {
      const env = buildRuntimeEnvironment(request.credentialRef)

      if (request.runtime.model) {
        env['GITORCH_RUNTIME_MODEL'] = request.runtime.model
      }

      if (request.runtime.reasoning) {
        env['GITORCH_RUNTIME_REASONING'] = request.runtime.reasoning
      }

      const modelArgs =
        options.modelArgName && request.runtime.model
          ? [options.modelArgName, request.runtime.model]
          : []

      const workspaceArgs =
        options.workspaceDirArgName && request.cwd ? [options.workspaceDirArgName, request.cwd] : []

      const promptArgs = options.promptViaStdin
        ? []
        : [...(options.promptSeparator ? [options.promptSeparator] : []), request.prompt]

      const result = await runner({
        binary: options.binary,
        args: [...baseArgs, ...modelArgs, ...workspaceArgs, ...promptArgs],
        env,
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        ...(options.promptViaStdin ? { stdin: request.prompt } : {}),
      })

      return {
        missionId: request.missionId,
        runtime: options.runtime,
        output: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      }
    },
  }
}

export interface CreatePythonSdkRuntimeAdapterOptions {
  runtime: F6AgentRuntime
  scriptPath: string
  pythonBinary?: string
}

export function createPythonSdkRuntimeAdapter(
  options: CreatePythonSdkRuntimeAdapterOptions
): RuntimeAdapter {
  const pythonBinary = options.pythonBinary ?? 'python3'

  return {
    runtime: options.runtime,
    async run(request: RuntimeExecutionRequest) {
      const env = buildRuntimeEnvironment(request.credentialRef)

      const model =
        request.runtime.model ??
        (request.runtime.runtime === 'antigravity' ? 'gemini-2.5-flash' : undefined)
      const reasoning = request.runtime.reasoning

      const args = [options.scriptPath, request.prompt]

      if (model) {
        args.push('--model', model)
      }

      // Pass reasoning as system instructions hint (optional)
      let systemInstructions: string | undefined
      if (reasoning) {
        systemInstructions = `Reasoning effort: ${reasoning}`
      }

      if (systemInstructions) {
        args.push('--system-instructions', systemInstructions)
      }

      // Modo diagnóstico: só as chaves Gemini são repassadas (allowlist), nunca
      // process.env inteiro. cwd e timeout mantêm paridade com o runner CLI.
      const geminiEnv: Record<string, string> = { ...env, ANTIGRAVITY_MODEL: model ?? '' }
      for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
        const value = process.env[key]
        if (value !== undefined) {
          geminiEnv[key] = value
        }
      }
      const start = Date.now()
      try {
        const pending = execFileAsync(pythonBinary, args, {
          env: buildChildProcessEnv(geminiEnv),
          cwd: request.cwd,
          maxBuffer: 16 * 1024 * 1024,
          timeout: request.timeoutMs,
          killSignal: 'SIGKILL',
        })
        // Mesmo motivo do runner CLI: stdin aberto = processo esperando EOF.
        pending.child.stdin?.end()
        const { stdout, stderr } = await pending
        return {
          missionId: request.missionId,
          runtime: options.runtime,
          output: stdout,
          stderr: stderr,
          exitCode: 0,
          durationMs: Date.now() - start,
        }
      } catch (error: unknown) {
        const err = error as {
          code?: number | string
          killed?: boolean
          signal?: string
          stdout?: string
          stderr?: string
          message?: string
        }
        const timedOut = err.killed === true || err.signal === 'SIGKILL'
        return {
          missionId: request.missionId,
          runtime: options.runtime,
          output: err.stdout || '',
          stderr: err.stderr || err.message || String(error),
          exitCode: timedOut ? 124 : normalizeExitCode(err.code),
          durationMs: Date.now() - start,
        }
      }
    },
  }
}
