import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import {
  RuntimeRegistry,
  buildRuntimeEnvironment,
  capPromptForArgv,
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

test('promptArgName entrega o prompt como valor da flag, sempre por último, e sem stdin', async () => {
  const calls: RuntimeCommandRequest[] = []
  const adapter = createCliRuntimeAdapter({
    runtime: 'antigravity',
    binary: 'agy',
    args: ['--sandbox', '--print-timeout', '20m', '--dangerously-skip-permissions'],
    modelArgName: '--model',
    workspaceDirArgName: '--add-dir',
    promptArgName: '--print',
    runner: async (request) => {
      calls.push(request)
      return { exitCode: 0, stdout: 'entregue', stderr: '', durationMs: 7 }
    },
  })

  await adapter.run({
    missionId: 'mission-agy-print',
    prompt: 'Analise o repositorio',
    runtime: { runtime: 'antigravity', model: 'gemini-x' },
    credentialRef: {
      connectionId: 'conn-agy-print',
      ownerScope: 'project',
      runtime: 'antigravity',
      providedSecrets: [],
    },
    cwd: '/workspace',
  })

  const args = calls[0]!.args
  // A missão é o VALOR de --print, e --print é a ÚLTIMA flag: com a missão em
  // qualquer outra posição o motor trata as próprias flags como a tarefa
  // (medido ao vivo: 0/3 pelo stdin, 0/1 como argumento solto, 2/2 assim).
  expect(args.slice(-2)).toEqual(['--print', 'Analise o repositorio'])
  expect(args).toEqual([
    '--sandbox',
    '--print-timeout',
    '20m',
    '--dangerously-skip-permissions',
    '--model',
    'gemini-x',
    '--add-dir',
    '/workspace',
    '--print',
    'Analise o repositorio',
  ])
  expect(calls[0]!.stdin).toBeUndefined()
})

test('realRuntimeCommandRunner writes request.stdin to the child stdin', async () => {
  const result = await realRuntimeCommandRunner({
    binary: process.execPath,
    args: ['-e', 'process.stdin.pipe(process.stdout)'],
    env: {},
    stdin: 'piped-in-content',
  })
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim()).toBe('piped-in-content')
})

test('realRuntimeCommandRunner runs a local command successfully', async () => {
  const request: RuntimeCommandRequest = {
    binary: process.execPath,
    args: ['-e', "console.log('hello world')"],
    env: { TEST_VAR: 'test_value' },
  }
  const result = await realRuntimeCommandRunner(request)
  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim()).toBe('hello world')
})

test('creates cli runtime adapter using realRuntimeCommandRunner by default', async () => {
  const adapter = createCliRuntimeAdapter({
    runtime: 'codex',
    binary: process.execPath,
    args: ['-e', "console.log('hello from adapter')"],
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
    binary: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 5000)'],
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

// Integração de ponta a ponta do teto de recursos (execution-limits.ts) com o
// runner real: um fake `systemd-run` no PATH devolve o próprio argv recebido,
// provando que realRuntimeCommandRunner de fato prefixa a execução quando a
// flag está ligada, e que o default (sem a flag) continua rodando cru.
describe('realRuntimeCommandRunner respeita GITORCH_EXEC_LIMITS', () => {
  let dir: string
  let prevLimits: string | undefined
  let prevPath: string | undefined

  beforeEach(() => {
    prevLimits = process.env.GITORCH_EXEC_LIMITS
    prevPath = process.env.PATH
  })

  afterEach(() => {
    if (prevLimits === undefined) delete process.env.GITORCH_EXEC_LIMITS
    else process.env.GITORCH_EXEC_LIMITS = prevLimits
    process.env.PATH = prevPath
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('modo systemd com systemd-run no PATH prefixa a execução com o wrapper de limites', async () => {
    if (process.platform === 'win32') return
    dir = mkdtempSync(join(tmpdir(), 'gitorch-systemd-run-'))
    writeFileSync(join(dir, 'systemd-run'), '#!/bin/sh\necho "SYSTEMD_ARGS:$@"\n')
    chmodSync(join(dir, 'systemd-run'), 0o755)

    process.env.GITORCH_EXEC_LIMITS = 'systemd'
    process.env.PATH = `${dir}${delimiter}${prevPath ?? ''}`

    const result = await realRuntimeCommandRunner({ binary: 'echo', args: ['hi'], env: {} })

    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(
      'SYSTEMD_ARGS:--user --scope --quiet -p MemoryMax=2G -p MemorySwapMax=0 -p CPUQuota=150% -- echo hi'
    )
  })

  test('sem a flag (default), o comando roda cru — systemd-run nem existe no PATH de teste', async () => {
    if (process.platform === 'win32') return
    delete process.env.GITORCH_EXEC_LIMITS

    const result = await realRuntimeCommandRunner({ binary: 'echo', args: ['hi'], env: {} })

    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('hi')
  })
})

// Achado importante da revisão: em repositório grande o contexto injetado
// (codegraph, entregável do RA, memórias, até 20 KB de diff no QA) não tinha
// teto, o prompt virava um argumento de linha de comando gigante e a missão
// morria com `spawn E2BIG` — sem failover, porque isFailoverError não
// reconhecia o erro (coberto em runtime-resolver.test.ts).
describe('capPromptForArgv (achado importante: E2BIG)', () => {
  test('prompt dentro do teto sai intacto, sem marcar truncated', () => {
    const prompt = 'Step: po-triage\n' + 'x'.repeat(1000)
    const r = capPromptForArgv(prompt, 96 * 1024)
    expect(r).toEqual({ prompt, truncated: false, originalBytes: Buffer.byteLength(prompt) })
  })

  test('prompt gigante (contexto sem teto) é cortado no MEIO, preservando cabeça e cauda', () => {
    const cabeca = 'You are the GitOrch Product Owner agent.\nStep: po-triage\n\n'
    // Simula o contexto sem teto (codegraph + memórias + diff de 20KB) que
    // hoje estoura sem este corte.
    const contextoGigante = 'CONTEXTO-'.repeat(50_000) // ~450KB
    const cauda =
      '\nDecide e responda SOMENTE com um JSON valido conforme o schema:\n{"campo":"valor"}\n'
    const prompt = cabeca + contextoGigante + cauda

    const maxBytes = 96 * 1024
    const r = capPromptForArgv(prompt, maxBytes)

    expect(r.truncated).toBe(true)
    expect(r.originalBytes).toBe(Buffer.byteLength(prompt, 'utf8'))
    // Nunca estoura o teto pedido.
    expect(Buffer.byteLength(r.prompt, 'utf8')).toBeLessThanOrEqual(maxBytes)
    // A pergunta do passo (cabeça) sobrevive.
    expect(r.prompt.startsWith(cabeca)).toBe(true)
    // O schema do formulário (cauda) sobrevive.
    expect(r.prompt.endsWith(cauda)).toBe(true)
    // O corte é explícito, não silencioso.
    expect(r.prompt).toContain('GitOrch cortou o CONTEXTO aqui')
    expect(r.prompt).toContain(String(r.originalBytes))
  })

  test('teto configurável por env (GITORCH_MAX_PROMPT_ARG_BYTES) é respeitado quando não passado explicitamente', async () => {
    const prev = process.env['GITORCH_MAX_PROMPT_ARG_BYTES']
    try {
      process.env['GITORCH_MAX_PROMPT_ARG_BYTES'] = String(200)
      // Reimporta o módulo para pegar o valor do env no momento do load.
      vi.resetModules()
      const mod = await import('./runtime-adapter')
      const r = mod.capPromptForArgv('x'.repeat(10_000))
      expect(r.truncated).toBe(true)
      expect(Buffer.byteLength(r.prompt, 'utf8')).toBeLessThanOrEqual(200)
    } finally {
      if (prev === undefined) delete process.env['GITORCH_MAX_PROMPT_ARG_BYTES']
      else process.env['GITORCH_MAX_PROMPT_ARG_BYTES'] = prev
      vi.resetModules()
    }
  })
})

describe('createCliRuntimeAdapter corta o prompt gigante antes de virar argumento (E2BIG)', () => {
  test('promptArgName: prompt gigante é cortado antes de ir para args, e o corte é avisado', async () => {
    const calls: RuntimeCommandRequest[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const adapter = createCliRuntimeAdapter({
        runtime: 'antigravity',
        binary: 'agy',
        args: ['--sandbox'],
        promptArgName: '--print',
        runner: async (request) => {
          calls.push(request)
          return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }
        },
      })

      const promptGigante = 'Step: qa-verdict\n' + 'DIFF-'.repeat(60_000) // bem acima de 96KB

      await adapter.run({
        missionId: 'mission-e2big',
        prompt: promptGigante,
        runtime: { runtime: 'antigravity' },
        credentialRef: {
          connectionId: 'c1',
          ownerScope: 'project',
          runtime: 'antigravity',
          providedSecrets: [],
        },
      })

      const sentPrompt = calls[0]!.args.at(-1) as string
      expect(Buffer.byteLength(sentPrompt, 'utf8')).toBeLessThan(Buffer.byteLength(promptGigante))
      expect(sentPrompt.startsWith('Step: qa-verdict')).toBe(true)
      expect(warnSpy).toHaveBeenCalled()
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('E2BIG')
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('promptViaStdin: prompt gigante NÃO é cortado (não vira argv, não corre risco de E2BIG)', async () => {
    const calls: RuntimeCommandRequest[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const adapter = createCliRuntimeAdapter({
        runtime: 'antigravity',
        binary: 'agy',
        args: ['--print'],
        promptViaStdin: true,
        runner: async (request) => {
          calls.push(request)
          return { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 1 }
        },
      })

      const promptGigante = 'CONTEXTO-'.repeat(50_000)

      await adapter.run({
        missionId: 'mission-stdin-gigante',
        prompt: promptGigante,
        runtime: { runtime: 'antigravity' },
        credentialRef: {
          connectionId: 'c1',
          ownerScope: 'project',
          runtime: 'antigravity',
          providedSecrets: [],
        },
      })

      expect(calls[0]!.stdin).toBe(promptGigante)
      expect(calls[0]!.args).not.toContain(promptGigante)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})
