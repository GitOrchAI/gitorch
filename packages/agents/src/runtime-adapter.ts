import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  AgentRuntimeSelection,
  F6AgentRole,
  F6AgentRuntime,
  RuntimeCredentialRef,
} from './types'
import { wrapWithLimits, type ExecutionLimits } from './execution-limits'

const execFileAsync = promisify(execFile)

// Teto por execução (ver execution-limits.ts). Configurável por env; o
// default (2G/0/150%) é o valor da radiografia para a VM dev (ARM 4CPU/11GB) —
// só entra em vigor quando GITORCH_EXEC_LIMITS=systemd; caso contrário o
// comando roda cru, exatamente como antes desta mudança.
//
// MemorySwapMax default '0' (proíbe swap ADICIONAL além do MemoryMax): sem
// isto, provado ao vivo que MemoryMax sozinho NÃO mata o processo nesta VM
// (9GB de swap) — ele escorre e termina normal. Ver execution-limits.ts.
const EXEC_LIMITS: ExecutionLimits = {
  memoryMax: process.env['GITORCH_EXEC_MEMORY_MAX'] ?? '2G',
  memorySwapMax: process.env['GITORCH_EXEC_MEMORY_SWAP_MAX'] ?? '0',
  cpuQuota: process.env['GITORCH_EXEC_CPU_QUOTA'] ?? '150%',
}

export interface RuntimeExecutionRequest {
  missionId: string
  prompt: string
  runtime: AgentRuntimeSelection
  credentialRef: RuntimeCredentialRef
  /** Papel do agente nesta missão (RA/PO/SM/QA). Vira GITORCH_AGENT_ROLE no
   *  ambiente do container: o entrypoint usa para filtrar os MCPs do papel. */
  role?: F6AgentRole
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
  failedStep?: string
  errorDetails?: string
  recoveryAction?: 'auto-rollback' | 'none'
}

/**
 * Executes a function representing a step and annotates errors with the step name.
 */
export async function wrapExecutionStep<T>(
  stepName: string,
  fn: () => Promise<T> | T
): Promise<{ result?: T; error?: Error; failedStep?: string }> {
  try {
    const result = await fn()
    return { result }
  } catch (err: unknown) {
    return {
      error: err instanceof Error ? err : new Error(String(err)),
      failedStep: stepName,
    }
  }
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

// Achado importante da revisão pós-merge: quando o prompt vira um único
// argumento de linha de comando (ver promptArgs em createCliRuntimeAdapter),
// o Linux estoura com `spawn E2BIG` acima de ~128 KiB por argumento (e o
// limite real conta TODO o argv+env do processo, não só este argumento).
// Ficamos bem abaixo do teto do SO pra sobrar espaço pro resto do argv/env
// (binário, flags, PATH/HOME etc.). Configurável só para teste/ajuste fino —
// não existe motivo de produção pra subir isto perto do limite real do SO.
const MAX_PROMPT_ARG_BYTES = Number(process.env['GITORCH_MAX_PROMPT_ARG_BYTES'] ?? 96 * 1024)

export interface CapPromptResult {
  prompt: string
  truncated: boolean
  originalBytes: number
}

/**
 * Corta o MEIO de um prompt grande demais para virar argumento de linha de
 * comando sem estourar E2BIG — nunca a ponta. Os prompts dos trilhos
 * (buildStepPrompt em @gitorch/cadence) têm formato fixo: identidade do
 * papel + "Step: <id>" (a pergunta do passo) no INÍCIO, e o schema JSON do
 * formulário + instrução final no FIM; só o meio (playbook + contexto
 * injetado pelo sistema — codegraph, memórias, diff) pode crescer sem teto.
 * Preservar cabeça e cauda, cortando só o meio, garante que a pergunta do
 * passo e o schema NUNCA são os que somem — é sempre o contexto, com um
 * marcador explícito de quanto foi cortado.
 */
export function capPromptForArgv(
  prompt: string,
  maxBytes: number = MAX_PROMPT_ARG_BYTES
): CapPromptResult {
  const originalBytes = Buffer.byteLength(prompt, 'utf8')
  if (originalBytes <= maxBytes) {
    return { prompt, truncated: false, originalBytes }
  }

  const marker = `\n\n[...GitOrch cortou o CONTEXTO aqui: prompt original tinha ${originalBytes} bytes, acima do teto de ${maxBytes} (GITORCH_MAX_PROMPT_ARG_BYTES) para nao estourar E2BIG...]\n\n`
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  const budget = Math.max(maxBytes - markerBytes, 0)
  // Cabeça maior que a cauda: a cabeça carrega a identidade+pergunta do
  // passo (curta e fixa); a cauda só precisa do schema+instrução final.
  const headBytes = Math.floor(budget * 0.6)
  const tailBytes = budget - headBytes

  const buf = Buffer.from(prompt, 'utf8')
  const head = buf.subarray(0, headBytes).toString('utf8')
  const tail = buf.subarray(Math.max(buf.length - tailBytes, headBytes)).toString('utf8')

  return { prompt: head + marker + tail, truncated: true, originalBytes }
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
  // GITORCH_EXEC_LIMITS=systemd + systemd-run no PATH: prefixa a execução com
  // o cgroup transitório do teto. Em qualquer outro caso devolve o comando
  // intacto (ver execution-limits.ts) — a linha abaixo é um no-op hoje.
  const { binary, args } = wrapWithLimits(request.binary, request.args, EXEC_LIMITS)
  try {
    const pending = execFileAsync(binary, args, {
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
  /**
   * Entrega o prompt como VALOR desta flag, sempre no fim da linha de comando
   * (ex.: '--print'). Necessário para o Antigravity CLI a partir da 1.1.x: a
   * missão precisa ser o valor de `--print`. Medido ao vivo contra a imagem
   * real: pelo stdin 0/3, como argumento posicional solto 0/1, assim 2/2 —
   * em qualquer outra forma o motor trata as próprias flags como a tarefa.
   * Tem precedência sobre `promptViaStdin` e sobre o prompt posicional.
   */
  promptArgName?: string
}

export function createCliRuntimeAdapter(options: CreateCliRuntimeAdapterOptions): RuntimeAdapter {
  const runner = options.runner ?? realRuntimeCommandRunner

  const baseArgs = [...(options.args ?? [])]

  return {
    runtime: options.runtime,
    async run(request: RuntimeExecutionRequest) {
      const env = buildRuntimeEnvironment(request.credentialRef)

      if (request.role) {
        env['GITORCH_AGENT_ROLE'] = request.role
      }

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

      // O prompt só corre risco de E2BIG quando vira ARGUMENTO de linha de
      // comando (promptArgName ou posicional); pelo stdin não há esse teto
      // do SO, então não cortamos ali.
      const goesViaArgv = !(options.promptViaStdin && !options.promptArgName)
      const cappedPrompt = goesViaArgv ? capPromptForArgv(request.prompt) : undefined
      if (cappedPrompt?.truncated) {
        // Sem logger injetado nesta camada (biblioteca pura, sem FastifyInstance);
        // console é o mesmo fallback já usado em outros pontos do backend sem
        // `app` em escopo. O aviso é o que a revisão pediu: nunca truncar calado.
        console.warn(
          `[runtime-adapter] prompt de ${options.runtime} cortado de ${cappedPrompt.originalBytes} para ~${MAX_PROMPT_ARG_BYTES} bytes antes de virar argumento (evita spawn E2BIG); missão ${request.missionId}`
        )
      }
      const effectivePrompt = cappedPrompt?.prompt ?? request.prompt

      const promptArgs = options.promptArgName
        ? [options.promptArgName, effectivePrompt]
        : options.promptViaStdin
          ? []
          : [...(options.promptSeparator ? [options.promptSeparator] : []), effectivePrompt]

      const { result, error, failedStep } = await wrapExecutionStep('execute-runner', () =>
        runner({
          binary: options.binary,
          args: [...baseArgs, ...modelArgs, ...workspaceArgs, ...promptArgs],
          env,
          cwd: request.cwd,
          timeoutMs: request.timeoutMs,
          ...(options.promptViaStdin && !options.promptArgName ? { stdin: request.prompt } : {}),
        })
      )

      if (error) {
        return {
          missionId: request.missionId,
          runtime: options.runtime,
          output: '',
          stderr: String(error.message),
          exitCode: 1,
          durationMs: 0,
          failedStep: failedStep ?? 'execute-runner',
          errorDetails: String(error.message),
          recoveryAction: 'none',
        }
      }

      if (result) {
        const failed = result.exitCode !== 0
        return {
          missionId: request.missionId,
          runtime: options.runtime,
          output: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          ...(failed
            ? {
                failedStep: 'execute-runner',
                errorDetails: result.stderr,
                recoveryAction: 'none',
              }
            : {}),
        }
      }

      throw new Error('Unexpected execution flow in runtime adapter')
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
          failedStep: 'execute-python-script',
          errorDetails: err.message || String(error),
          recoveryAction: 'none',
        }
      }
    },
  }
}
