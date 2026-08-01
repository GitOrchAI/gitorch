import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import type { RuntimeCommandRunner } from '@gitorch/agents'
import { runBootReaper, schedulerPlugin } from './scheduler.js'

// Ceifador de boot (F2.1.4): duas propriedades têm que valer por construção —
// (a) escopo preciso (só container gitorch-mission-* e só mission 'running',
// já provado em boot-reaper.test.ts) e (b) NUNCA roda sob
// GITORCH_PIPELINE_CHECK=1 (o probe inerte da esteira, F2.1.2). Este arquivo
// prova (b) no ponto real de wiring (schedulerPlugin) e a robustez de
// runBootReaper (nunca derruba o boot, mesmo com o runtime de container
// falhando).

const ENV_KEYS = ['GITORCH_EXECUTOR', 'GITORCH_CONTAINER_ENGINE', 'GITORCH_PIPELINE_CHECK']

describe('runBootReaper', () => {
  const original: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
  })

  const fakeLog = { info: () => undefined, warn: vi.fn(), error: vi.fn() }

  function fakePrisma(count = 2) {
    const updateMany = vi.fn(async (_args: unknown) => ({ count }))
    return { mission: { updateMany } }
  }

  it('executor=podman: lista/remove containers órfãos E falha as missões running', async () => {
    process.env['GITORCH_EXECUTOR'] = 'podman'
    const calls: string[][] = []
    const run: RuntimeCommandRunner = async (req) => {
      calls.push([req.binary, ...req.args])
      if (req.args[0] === 'ps') {
        return { exitCode: 0, stdout: 'gitorch-mission-x\n', stderr: '', durationMs: 0 }
      }
      return { exitCode: 0, stdout: '', stderr: '', durationMs: 0 }
    }
    const prisma = fakePrisma(1)
    const app = { log: fakeLog, prisma } as never

    await runBootReaper(app, run)

    expect(calls[0]?.[1]).toBe('ps')
    expect(calls[1]).toEqual(['podman', 'rm', '-f', 'gitorch-mission-x'])
    expect(prisma.mission.updateMany).toHaveBeenCalledTimes(1)
    const arg = prisma.mission.updateMany.mock.calls[0]?.[0] as { where: { status: string } }
    expect(arg.where).toEqual({ status: 'running' })
  })

  it('executor local-process (default): NUNCA chama o runtime de container, mas ainda falha as missões running', async () => {
    const run = vi.fn<RuntimeCommandRunner>()
    const prisma = fakePrisma(4)
    const app = { log: fakeLog, prisma } as never

    await runBootReaper(app, run)

    expect(run).not.toHaveBeenCalled()
    expect(prisma.mission.updateMany).toHaveBeenCalledTimes(1)
  })

  it('listagem falhando via exitCode não-zero (CONTRATO REAL: podman ausente/permissão negada resolvem, nunca rejeitam — ver runtime-adapter.ts) NÃO derruba o boot — loga de verdade e segue para falhar as missões', async () => {
    process.env['GITORCH_EXECUTOR'] = 'podman'
    const run: RuntimeCommandRunner = async (req) => {
      if (req.args[0] === 'ps') {
        return { exitCode: 127, stdout: '', stderr: 'podman: command not found', durationMs: 0 }
      }
      throw new Error('não deveria chamar rm sem containers listados')
    }
    // count=0: a única fonte possível de um warn neste teste é a falha de
    // listagem — se `prisma` também gerasse um warn (missões órfãs > 0), um
    // `toHaveBeenCalled()` genérico passaria mesmo sem o ceifador jamais
    // enxergar a falha do `ps` (foi exatamente esse falso-positivo que
    // escondeu o bug original).
    const prisma = fakePrisma(0)
    const app = { log: fakeLog, prisma } as never

    // fakeLog é compartilhado entre os `it` deste describe (nunca resetado
    // no beforeEach) — limpa antes de checar, senão `toHaveBeenCalled()`
    // fica trivialmente verdadeiro por causa de um teste anterior e não prova
    // nada sobre ESTE cenário (achado crítico da review).
    fakeLog.warn.mockClear()
    await expect(runBootReaper(app, run)).resolves.toBeUndefined()
    // Sem o check de exitCode, stdout vazio é indistinguível de "zero
    // órfãos" e este warn nunca dispara.
    expect(fakeLog.warn).toHaveBeenCalled()
    const warnMessages = fakeLog.warn.mock.calls.map((call) =>
      call.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' | ')
    )
    expect(warnMessages.some((m) => m.includes('listar'))).toBe(true)
  })

  it('rm falhando via exitCode não-zero (CONTRATO REAL do runner) NÃO é contado como removido — log honesto, container continua de pé', async () => {
    process.env['GITORCH_EXECUTOR'] = 'podman'
    const run: RuntimeCommandRunner = async (req) => {
      if (req.args[0] === 'ps') {
        return { exitCode: 0, stdout: 'gitorch-mission-x\n', stderr: '', durationMs: 0 }
      }
      // rm nunca rejeita no contrato real — resolve com exitCode != 0.
      return { exitCode: 1, stdout: '', stderr: 'no such container', durationMs: 0 }
    }
    const prisma = fakePrisma(0)
    const app = { log: fakeLog, prisma } as never

    // fakeLog é compartilhado entre os `it` deste describe (nunca resetado
    // no beforeEach) — limpa antes de inspecionar conteúdo de mensagem, senão
    // um "removidos" de um teste anterior faz esta asserção mentir.
    fakeLog.warn.mockClear()
    await runBootReaper(app, run)

    const warnMessages = fakeLog.warn.mock.calls.map((call) =>
      typeof call[0] === 'string' ? call[0] : call[1]
    )
    // Nunca reporta sucesso de remoção para um `rm` que não confirmou.
    expect(warnMessages.some((m) => typeof m === 'string' && m.includes('removidos'))).toBe(false)
    expect(warnMessages.some((m) => typeof m === 'string' && m.includes('falharam'))).toBe(true)
  })

  it('runtime rejeitando (caminho genuinamente excepcional, não o contrato real do runner) NÃO derruba o boot — loga e segue para falhar as missões', async () => {
    process.env['GITORCH_EXECUTOR'] = 'podman'
    const run: RuntimeCommandRunner = async () => {
      throw new Error('erro inesperado no runner')
    }
    const prisma = fakePrisma(1)
    const app = { log: fakeLog, prisma } as never

    await expect(runBootReaper(app, run)).resolves.toBeUndefined()
    expect(fakeLog.warn).toHaveBeenCalled()
    expect(prisma.mission.updateMany).toHaveBeenCalledTimes(1)
  })

  it('prisma.updateMany falhando NÃO derruba o boot — loga e resolve', async () => {
    const run = vi.fn<RuntimeCommandRunner>()
    const prisma = {
      mission: { updateMany: vi.fn(async () => Promise.reject(new Error('db down'))) },
    }
    const app = { log: fakeLog, prisma } as never

    await expect(runBootReaper(app, run)).resolves.toBeUndefined()
    expect(fakeLog.warn).toHaveBeenCalled()
  })
})

describe('boot reaper wiring em schedulerPlugin (real seam)', () => {
  const originalNodeEnv = process.env['NODE_ENV']

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key]
  })

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key]
    if (originalNodeEnv === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = originalNodeEnv
  })

  // NODE_ENV='production' de propósito nos dois testes abaixo: sob
  // NODE_ENV='test' (o padrão da suíte) o próprio guard do ceifador já
  // desarma a chamada — testar só sob 'test' provaria o guard errado
  // (mascararia uma remoção do guard de pipeline-check). Forçar 'production'
  // isola exatamente a propriedade (b) do brief: pipeline-check tem que ser
  // o motivo do ceifador não rodar, não o ambiente de teste.
  it('GITORCH_PIPELINE_CHECK=1: o ceifador NUNCA chega a tocar o prisma', async () => {
    process.env['NODE_ENV'] = 'production'
    process.env['GITORCH_PIPELINE_CHECK'] = '1'
    const updateMany = vi.fn(async (_args: unknown) => ({ count: 0 }))
    const app = Fastify({ logger: false })
    app.decorate('prisma', { mission: { updateMany } } as never)
    await app.register(schedulerPlugin)
    // Dá tempo pro fire-and-forget rodar, se o guard estivesse quebrado.
    await new Promise((resolve) => setImmediate(resolve))
    expect(updateMany).not.toHaveBeenCalled()
    await app.close()
  })

  it('fora de pipeline-check: o boot chama o ceifador de verdade (mission.updateMany é tocado)', async () => {
    process.env['NODE_ENV'] = 'production'
    // GITORCH_EXECUTOR fica ausente (local-process): evita qualquer chamada
    // real ao runtime de container neste teste de wiring.
    const updateMany = vi.fn(async (_args: unknown) => ({ count: 0 }))
    const app = Fastify({ logger: false })
    app.decorate('prisma', { mission: { updateMany } } as never)
    await app.register(schedulerPlugin)
    await new Promise((resolve) => setImmediate(resolve))
    expect(updateMany).toHaveBeenCalledTimes(1)
    const arg = updateMany.mock.calls[0]?.[0] as { where: { status: string } }
    expect(arg.where).toEqual({ status: 'running' })
    await app.close()
  })
})
