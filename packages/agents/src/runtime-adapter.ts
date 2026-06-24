import type { AgentRuntimeSelection, F6AgentRuntime, RuntimeCredentialRef } from './types'

export interface RuntimeExecutionRequest {
  missionId: string
  prompt: string
  runtime: AgentRuntimeSelection
  credentialRef: RuntimeCredentialRef
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
}

const unsupportedRuntimeCommandRunner: RuntimeCommandRunner = () => {
  throw new Error('Runtime adapter runner is not configured')
}

export function createCliRuntimeAdapter(options: CreateCliRuntimeAdapterOptions): RuntimeAdapter {
  const runner = options.runner ?? unsupportedRuntimeCommandRunner
  const baseArgs = [...(options.args ?? [])]

  return {
    runtime: options.runtime,
    async run(request) {
      const env = buildRuntimeEnvironment(request.credentialRef)

      if (request.runtime.model) {
        env['GITORCH_RUNTIME_MODEL'] = request.runtime.model
      }

      if (request.runtime.reasoning) {
        env['GITORCH_RUNTIME_REASONING'] = request.runtime.reasoning
      }

      const result = await runner({
        binary: options.binary,
        args: [...baseArgs, request.prompt],
        env,
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
