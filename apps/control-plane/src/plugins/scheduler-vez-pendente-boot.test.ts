import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// D16, no ponto REAL de wiring (schedulerPlugin), não só na função pura
// (vez-pendente.test.ts): prova que o registro do plugin de fato chama a
// retomada de vez pendente no boot — sem esperar tique nem cron — e que ela
// nunca roda sob NODE_ENV='test' (mesmo guard do ceifador de boot, pelo
// mesmo motivo: a suíte roda contra Prisma de teste e disparar missão real
// aqui quebraria isolamento).

describe('retomada de vez pendente no boot, wiring em schedulerPlugin (real seam)', () => {
  const originalNodeEnv = process.env['NODE_ENV']

  function fakePrisma(vezesPendentes: unknown[] = []) {
    return {
      mission: { updateMany: vi.fn(async (_args: unknown) => ({ count: 0 })) },
      vezPendente: {
        findMany: vi.fn(async (_args: unknown) => vezesPendentes),
        update: vi.fn(async (_args: unknown) => ({ tentativas: 1 })),
        deleteMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
        upsert: vi.fn(async (_args: unknown) => ({})),
      },
      event: { create: vi.fn(async (_args: unknown) => ({})) },
    }
  }

  afterEach(async () => {
    if (originalNodeEnv === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = originalNodeEnv
  })

  // NODE_ENV='production' de propósito, mesmo raciocínio do ceifador de boot
  // (scheduler-boot-reaper.test.ts): sob NODE_ENV='test' (o padrão da suíte)
  // o próprio guard já desarma a chamada — testar só sob 'test' provaria o
  // guard errado (mascararia a remoção do guard de verdade).
  it('sem vez pendente: a leitura acontece no boot, sem disparar nada', async () => {
    process.env['NODE_ENV'] = 'production'
    const prisma = fakePrisma([])
    const app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)
    await new Promise((resolve) => setImmediate(resolve))

    expect(prisma.vezPendente.findMany).toHaveBeenCalledTimes(1)
    expect(prisma.vezPendente.update).not.toHaveBeenCalled()
    await app.close()
  })

  it('NODE_ENV=test (padrão da suíte): a retomada NUNCA toca o prisma — mesmo guard do ceifador de boot', async () => {
    process.env['NODE_ENV'] = 'test'
    const prisma = fakePrisma([{ id: 'v1', projectId: 'proj1', agentRole: 'po', tentativas: 0 }])
    const app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)
    await new Promise((resolve) => setImmediate(resolve))

    expect(prisma.vezPendente.findMany).not.toHaveBeenCalled()
    await app.close()
  })

  it('vez pendente presente: o boot INCREMENTA tentativas antes de qualquer disparo — prova que a linha persistida foi lida e processada na subida, sem esperar tique', async () => {
    process.env['NODE_ENV'] = 'production'
    const prisma = fakePrisma([{ id: 'v1', projectId: 'proj1', agentRole: 'po', tentativas: 0 }])
    const app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    expect(prisma.vezPendente.update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { tentativas: { increment: 1 } },
    })
    await app.close()
  })
})
