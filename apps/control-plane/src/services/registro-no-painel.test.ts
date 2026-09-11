// DJ-T6b: `registrarNoPainelUmaVez` — dedupe do registro de auditoria na
// timeline do painel (`type: 'audit'`, `GET /api/v1/painel/timeline`).
//
// ACHADO DA REVISÃO (DJ-T6): `registrarEscaladaNoPainel`
// (plugins/scheduler.ts) grava um evento `audit` a cada passada que decide
// "escalar" o MESMO PR, sem checar se já existe um igual — cada varredura
// duplica a linha na timeline. Este teste prova o dedupe por `payload.chave`
// antes do conserto existir (RED), e o conserto (`registrarNoPainelUmaVez`)
// faz os dois passarem (GREEN).

import { describe, expect, it, vi } from 'vitest'
import { registrarNoPainelUmaVez } from './registro-no-painel.js'

function prismaFake(eventosExistentes: Array<{ payload: unknown }>) {
  const create = vi.fn().mockResolvedValue({})
  const findFirst = vi.fn(async ({ where }: { where: { payload: unknown } }) => {
    const cond = where.payload as { path: string[]; equals: string }
    return (
      eventosExistentes.find((e) => {
        const p = e.payload as Record<string, unknown>
        return p[cond.path[0] as string] === cond.equals
      }) ?? null
    )
  })
  return { event: { create, findFirst } }
}

describe('registrarNoPainelUmaVez', () => {
  it('duas escaladas seguidas do MESMO pr → grava só 1 evento audit', async () => {
    const eventos: Array<{ payload: unknown }> = []
    const prisma = prismaFake(eventos)
    prisma.event.create.mockImplementation(async ({ data }: { data: { payload: unknown } }) => {
      eventos.push({ payload: data.payload })
      return {}
    })

    const args = {
      prisma: prisma as never,
      projectId: 'proj-1',
      chave: 'retomada-travada:dono/repo:42',
      texto: 'PR #42 travado',
    }
    await registrarNoPainelUmaVez(args)
    await registrarNoPainelUmaVez(args)

    expect(prisma.event.create).toHaveBeenCalledTimes(1)
    expect(eventos).toHaveLength(1)
  })

  it('PR diferente → grava 2 eventos audit (um por chave)', async () => {
    const eventos: Array<{ payload: unknown }> = []
    const prisma = prismaFake(eventos)
    prisma.event.create.mockImplementation(async ({ data }: { data: { payload: unknown } }) => {
      eventos.push({ payload: data.payload })
      return {}
    })

    await registrarNoPainelUmaVez({
      prisma: prisma as never,
      projectId: 'proj-1',
      chave: 'retomada-travada:dono/repo:42',
      texto: 'PR #42 travado',
    })
    await registrarNoPainelUmaVez({
      prisma: prisma as never,
      projectId: 'proj-1',
      chave: 'retomada-travada:dono/repo:43',
      texto: 'PR #43 travado',
    })

    expect(prisma.event.create).toHaveBeenCalledTimes(2)
    expect(eventos).toHaveLength(2)
  })

  it('mesma identidade de automação → grava só 1 evento audit', async () => {
    const eventos: Array<{ payload: unknown }> = []
    const prisma = prismaFake(eventos)
    prisma.event.create.mockImplementation(async ({ data }: { data: { payload: unknown } }) => {
      eventos.push({ payload: data.payload })
      return {}
    })

    const args = {
      prisma: prisma as never,
      projectId: 'proj-1',
      chave: 'automacao:dono/repo:wf:123',
      texto: 'automação falhando',
    }
    await registrarNoPainelUmaVez(args)
    await registrarNoPainelUmaVez(args)

    expect(prisma.event.create).toHaveBeenCalledTimes(1)
  })

  it('grava payload com texto E chave — a timeline continua lendo payload.texto', async () => {
    const eventos: Array<{ payload: unknown }> = []
    const prisma = prismaFake(eventos)
    prisma.event.create.mockImplementation(async ({ data }: { data: { payload: unknown } }) => {
      eventos.push({ payload: data.payload })
      return {}
    })

    await registrarNoPainelUmaVez({
      prisma: prisma as never,
      projectId: 'proj-1',
      chave: 'automacao:dono/repo:wf:123',
      texto: 'automação falhando',
    })

    expect(eventos[0]?.payload).toEqual({
      texto: 'automação falhando',
      chave: 'automacao:dono/repo:wf:123',
    })
  })
})
