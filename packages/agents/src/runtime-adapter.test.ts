import {
  RuntimeRegistry,
  buildRuntimeEnvironment,
  createCliRuntimeAdapter,
  realRuntimeCommandRunner,
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

test('promptViaStdin delivers the prompt on stdin and keeps it out of argv', async () => {
  const calls: RuntimeCommandRequest[] = []
  const adapter = createCliRuntimeAdapter({
    runtime: 'antigravity',
    binary: 'agy',
    args: ['--print', '--sandbox'],
    workspaceDirArgName: '--add-dir',
    promptViaStdin: true,
    runner: async (request) => {
      calls.push(request)
      return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }
    },
  })

  await adapter.run({
    missionId: 'm-stdin',
    prompt: 'Produce the Research Brief',
    runtime: { runtime: 'antigravity' },
    cwd: '/workspace',
    credentialRef: {
      connectionId: 'c1',
      ownerScope: 'project',
      runtime: 'antigravity',
      providedSecrets: [],
    },
  })

  // The prompt must NOT appear as a positional arg (the engine would fixate on
  // its own CLI flags); it must arrive on stdin.
  expect(calls[0].args).toEqual(['--print', '--sandbox', '--add-dir', '/workspace'])
  expect(calls[0].args).not.toContain('Produce the Research Brief')
  expect(calls[0].stdin).toBe('Produce the Research Brief')
})

test('realRuntimeCommandRunner writes request.stdin to the child stdin', async () => {
  const result = await realRuntimeCommandRunner({
    binary: 'cat',
    args: [],
    env: {},
    stdin: 'piped-in-content',
  })
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim()).toBe('piped-in-content')
})

test('realRuntimeCommandRunner runs a local command successfully', async () => {
  const request: RuntimeCommandRequest = {
    binary: 'echo',
    args: ['hello world'],
    env: { TEST_VAR: 'test_value' },
  }
  const result = await realRuntimeCommandRunner(request)
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim()).toBe('hello world')
})

test('creates cli runtime adapter using realRuntimeCommandRunner by default', async () => {
  const adapter = createCliRuntimeAdapter({
    runtime: 'codex',
    binary: 'echo',
    args: ['hello from adapter'],
  })

  const result = await adapter.run({
    missionId: 'mission-codex-1',
    prompt: '',
    runtime: { runtime: 'codex' },
    credentialRef: {
      connectionId: 'conn-codex-1',
      ownerScope: 'organization',
      runtime: 'codex',
      providedSecrets: [],
    },
  })

  expect(result.exitCode).toBe(0)
  expect(result.output.trim()).toBe('hello from adapter')
})

test('buildChildProcessEnv nunca vaza segredos do control plane para o agente', async () => {
  const { buildChildProcessEnv } = await import('./runtime-adapter')
  const prev = {
    DATABASE_URL: process.env.DATABASE_URL,
    JWT_SECRET: process.env.JWT_SECRET,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  }
  process.env.DATABASE_URL = 'postgres://secret'
  process.env.JWT_SECRET = 'super-secret'
  process.env.TELEGRAM_BOT_TOKEN = 'tg-secret'
  try {
    const env = buildChildProcessEnv({ GITORCH_RUNTIME: 'antigravity' })
    expect(env.DATABASE_URL).toBeUndefined()
    expect(env.JWT_SECRET).toBeUndefined()
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined()
    expect(env.GITORCH_RUNTIME).toBe('antigravity')
    expect(env.PATH).toBe(process.env.PATH)
  } finally {
    process.env.DATABASE_URL = prev.DATABASE_URL
    process.env.JWT_SECRET = prev.JWT_SECRET
    process.env.TELEGRAM_BOT_TOKEN = prev.TELEGRAM_BOT_TOKEN
  }
})

test('runner reporta timeout como exitCode 124, nunca sucesso', async () => {
  const result = await realRuntimeCommandRunner({
    binary: 'sleep',
    args: ['5'],
    env: {},
    timeoutMs: 200,
  })
  expect(result.exitCode).toBe(124)
})

describe('createCliRuntimeAdapter promptSeparator', () => {
  test('insere o separador imediatamente antes do prompt (flags variádicas não o engolem)', async () => {
    const runner = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', durationMs: 1 })
    const adapter = createCliRuntimeAdapter({
      runtime: 'claude',
      binary: 'claude',
      args: ['-p', '--allowedTools', 'Read,Glob,Grep'],
      workspaceDirArgName: '--add-dir',
      promptSeparator: '--',
      runner,
    })

    await adapter.run({
      missionId: 'm1',
      prompt: 'analyze',
      cwd: '/ws/p',
      runtime: { runtime: 'claude' },
      credentialRef: {
        connectionId: 'c1',
        ownerScope: 'project',
        runtime: 'claude',
        providedSecrets: [],
      },
    })

    const args: string[] = runner.mock.calls[0][0].args
    expect(args.slice(-2)).toEqual(['--', 'analyze'])
    expect(args[args.indexOf('--add-dir') + 1]).toBe('/ws/p')
  })
})
