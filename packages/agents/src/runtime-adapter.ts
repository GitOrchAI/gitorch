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
    const { stdout, stderr } = await execFileAsync(request.binary, request.args, {
      env: { ...process.env, ...request.env },
      cwd: request.cwd,
      // Saída de CLIs agênticos pode passar do 1MB default do execFile.
      maxBuffer: 16 * 1024 * 1024,
    })
    return {
      exitCode: 0,
      stdout,
      stderr,
      durationMs: Date.now() - start,
    }
  } catch (error: unknown) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message?: string }
    return {
      exitCode: err.code || 1,
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
  return {
    GITORCH_RUNTIME_CONNECTION_ID: ref.connectionId,
    GITORCH_RUNTIME_OWNER_SCOPE: ref.ownerScope,
    GITORCH_RUNTIME: ref.runtime,
    GITORCH_PROVIDED_SECRETS: ref.providedSecrets.join(','),
  }
}

export interface CreateCliRuntimeAdapterOptions {
  runtime: F6AgentRuntime
  binary: string
  args?: string[]
  runner?: RuntimeCommandRunner
  /** Nome da flag de modelo do CLI (ex.: '--model'); quando presente, o modelo da missão vira argumento. */
  modelArgName?: string
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

      const result = await runner({
        binary: options.binary,
        args: [...baseArgs, ...modelArgs, request.prompt],
        env,
        cwd: request.cwd,
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

      // API key is passed via environment (GEMINI_API_KEY)
      const start = Date.now()
      try {
        const { stdout, stderr } = await execFileAsync(pythonBinary, args, {
          env: { ...process.env, ...env, ANTIGRAVITY_MODEL: model ?? '' },
        })
        return {
          missionId: request.missionId,
          runtime: options.runtime,
          output: stdout,
          stderr: stderr,
          exitCode: 0,
          durationMs: Date.now() - start,
        }
      } catch (error: unknown) {
        const err = error as { code?: number; stdout?: string; stderr?: string; message?: string }
        return {
          missionId: request.missionId,
          runtime: options.runtime,
          output: err.stdout || '',
          stderr: err.stderr || err.message || String(error),
          exitCode: err.code || 1,
          durationMs: Date.now() - start,
        }
      }
    },
  }
}
