import {
  RuntimeRegistry,
  buildRuntimeEnvironment,
  createCliRuntimeAdapter,
  type RuntimeAdapter,
  type RuntimeCommandRequest,
} from './runtime-adapter'

test('builds runtime environment from credential metadata without secret values', () => {
  expect(
    buildRuntimeEnvironment({
      connectionId: 'conn-codex-1',
      ownerScope: 'organization',
      runtime: 'codex',
      providedSecrets: ['OPENAI_API_KEY'],
    })
  ).toEqual({
    GITORCH_RUNTIME_CONNECTION_ID: 'conn-codex-1',
    GITORCH_RUNTIME_OWNER_SCOPE: 'organization',
    GITORCH_RUNTIME: 'codex',
    GITORCH_PROVIDED_SECRETS: 'OPENAI_API_KEY',
  })
})

test('registers and resolves runtime adapters by runtime', () => {
  const registry = new RuntimeRegistry()
  const claudeAdapter: RuntimeAdapter = {
    runtime: 'claude',
    async run() {
      return {
        missionId: 'mission-claude-1',
        runtime: 'claude',
        output: 'ok',
        stderr: '',
        exitCode: 0,
        durationMs: 1,
      }
    },
  }

  registry.register(claudeAdapter)

  expect(registry.resolve('claude')).toBe(claudeAdapter)
  expect(() => registry.resolve('codex')).toThrow('No runtime adapter registered for codex')
})

test('creates cli runtime adapter that passes prompt and runtime environment to runner', async () => {
  const calls: RuntimeCommandRequest[] = []
  const args = ['--print']
  const adapter = createCliRuntimeAdapter({
    runtime: 'antigravity',
    binary: 'agy',
    args,
    runner: async (request) => {
      calls.push(request)
      return { exitCode: 0, stdout: 'mission complete', stderr: '', durationMs: 42 }
    },
  })
  args.push('--mutated')

  const result = await adapter.run({
    missionId: 'mission-agy-1',
    prompt: 'Map project docs',
    runtime: {
      runtime: 'antigravity',
      model: 'Gemini 3.1 Pro High',
      reasoning: 'high',
    },
    credentialRef: {
      connectionId: 'conn-agy-1',
      ownerScope: 'project',
      runtime: 'antigravity',
      providedSecrets: ['GOOGLE_APPLICATION_CREDENTIALS'],
    },
  })

  expect(calls).toEqual([
    {
      binary: 'agy',
      args: ['--print', 'Map project docs'],
      env: {
        GITORCH_RUNTIME_CONNECTION_ID: 'conn-agy-1',
        GITORCH_RUNTIME_OWNER_SCOPE: 'project',
        GITORCH_RUNTIME: 'antigravity',
        GITORCH_PROVIDED_SECRETS: 'GOOGLE_APPLICATION_CREDENTIALS',
        GITORCH_RUNTIME_MODEL: 'Gemini 3.1 Pro High',
        GITORCH_RUNTIME_REASONING: 'high',
      },
    },
  ])
  expect(result).toEqual({
    missionId: 'mission-agy-1',
    runtime: 'antigravity',
    output: 'mission complete',
    stderr: '',
    exitCode: 0,
    durationMs: 42,
  })
})

test('throws when cli runtime adapter has no configured runner', async () => {
  const adapter = createCliRuntimeAdapter({
    runtime: 'codex',
    binary: 'codex',
  })

  await expect(
    adapter.run({
      missionId: 'mission-codex-1',
      prompt: 'Map project docs',
      runtime: { runtime: 'codex' },
      credentialRef: {
        connectionId: 'conn-codex-1',
        ownerScope: 'organization',
        runtime: 'codex',
        providedSecrets: ['OPENAI_API_KEY'],
      },
    })
  ).rejects.toThrow('Runtime adapter runner is not configured')
})
