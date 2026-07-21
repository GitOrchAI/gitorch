import { describe, expect, test, vi } from 'vitest'
import { AgentQuestionService } from './agent-question.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
// Fake do Prisma para agent_questions + events: store em memória com os
// métodos que o serviço usa. Mesmo padrão de environment.test.ts/
// engine-connection.test.ts — NUNCA banco real.
function fakePrisma() {
  const questions = new Map<string, any>()
  const events: any[] = []
  let seq = 0
  return {
    questions,
    events,
    agentQuestion: {
      findFirst: vi.fn(async ({ where }: any) => {
        const rows = [...questions.values()].filter((r) => {
          if (where.projectId !== undefined && r.projectId !== where.projectId) return false
          if (where.dedupKey !== undefined && r.dedupKey !== where.dedupKey) return false
          if (where.status !== undefined && r.status !== where.status) return false
          return true
        })
        return rows[0] ?? null
      }),
      create: vi.fn(async ({ data }: any) => {
        const now = new Date()
        const rec = {
          id: `q_${++seq}`,
          context: null,
          dedupKey: null,
          answer: null,
          answeredAt: null,
          answeredVia: null,
          telegramMessageId: null,
          createdAt: now,
          updatedAt: now,
          ...data,
        }
        questions.set(rec.id, rec)
        return rec
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const rec = { ...questions.get(where.id), ...data, updatedAt: new Date() }
        questions.set(where.id, rec)
        return rec
      }),
      findMany: vi.fn(async ({ where }: any) => {
        return [...questions.values()].filter((r) => {
          if (where?.projectId !== undefined && r.projectId !== where.projectId) return false
          if (where?.userId !== undefined && r.userId !== where.userId) return false
          return true
        })
      }),
    },
    event: {
      create: vi.fn(async ({ data }: any) => {
        const rec = { id: `e_${++seq}`, createdAt: new Date(), metadata: null, ...data }
        events.push(rec)
        return rec
      }),
    },
  }
}

describe('AgentQuestionService.ask (W3.2.2)', () => {
  test('sem dedupKey: cria a dúvida (status open) + Event agent_question pro painel', async () => {
    const prisma = fakePrisma()
    const svc = new AgentQuestionService(prisma as any)

    const result = await svc.ask('user_1', 'proj_1', {
      text: 'Qual é o azul oficial do site?',
      context: 'Home, Preço e Painel usam 3 azuis diferentes',
      options: [
        { label: '#2563EB', value: '#2563EB' },
        { label: '#1E40AF', value: '#1E40AF' },
      ],
    })

    expect(result.deduped).toBe(false)
    expect(result.question.status).toBe('open')
    expect(result.question.projectId).toBe('proj_1')
    expect(result.question.userId).toBe('user_1')
    expect(prisma.agentQuestion.create).toHaveBeenCalledTimes(1)

    expect(prisma.events).toHaveLength(1)
    expect(prisma.events[0]).toMatchObject({
      projectId: 'proj_1',
      type: 'agent_question',
      payload: { questionId: result.question.id, text: 'Qual é o azul oficial do site?' },
    })
  })

  test('dedupKey sem nenhuma answered correspondente: cria normalmente (não é a mesma decisão)', async () => {
    const prisma = fakePrisma()
    const svc = new AgentQuestionService(prisma as any)

    const result = await svc.ask('user_1', 'proj_1', {
      text: 'Qual é o azul oficial?',
      dedupKey: 'cor-oficial-site',
    })

    expect(result.deduped).toBe(false)
    expect(prisma.agentQuestion.create).toHaveBeenCalledTimes(1)
  })

  test('dedupKey bate uma answered do MESMO projeto: devolve a decisão já tomada, SEM criar', async () => {
    const prisma = fakePrisma()
    prisma.questions.set('q_old', {
      id: 'q_old',
      projectId: 'proj_1',
      userId: 'user_1',
      text: 'Qual é o azul oficial?',
      dedupKey: 'cor-oficial-site',
      status: 'answered',
      answer: '#2563EB',
      options: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const svc = new AgentQuestionService(prisma as any)

    const result = await svc.ask('user_1', 'proj_1', {
      text: 'Qual é o azul oficial? (pergunta de novo)',
      dedupKey: 'cor-oficial-site',
    })

    expect(result.deduped).toBe(true)
    expect(result.question.id).toBe('q_old')
    expect(result.question.answer).toBe('#2563EB')
    expect(prisma.agentQuestion.create).not.toHaveBeenCalled()
    expect(prisma.events).toHaveLength(0)
  })

  test('dedupKey bate uma answered de OUTRO projeto: NÃO deduplica (isolamento por projeto)', async () => {
    const prisma = fakePrisma()
    prisma.questions.set('q_other_project', {
      id: 'q_other_project',
      projectId: 'proj_2',
      userId: 'user_2',
      text: 'Qual é o azul oficial?',
      dedupKey: 'cor-oficial-site',
      status: 'answered',
      answer: '#3B82F6',
      options: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const svc = new AgentQuestionService(prisma as any)

    const result = await svc.ask('user_1', 'proj_1', {
      text: 'Qual é o azul oficial?',
      dedupKey: 'cor-oficial-site',
    })

    expect(result.deduped).toBe(false)
    expect(prisma.agentQuestion.create).toHaveBeenCalledTimes(1)
  })

  test('notify injetado é chamado com a dúvida criada', async () => {
    const prisma = fakePrisma()
    const notify = vi.fn(async () => undefined)
    const svc = new AgentQuestionService(prisma as any, { notify })

    const result = await svc.ask('user_1', 'proj_1', { text: 'dúvida qualquer' })

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ id: result.question.id }))
  })

  test('notify que rejeita (ex.: Telegram fora do ar) NUNCA impede a criação — best-effort', async () => {
    const prisma = fakePrisma()
    const notify = vi.fn(async () => {
      throw new Error('ETIMEDOUT: api.telegram.org')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const svc = new AgentQuestionService(prisma as any, { notify })

    const result = await svc.ask('user_1', 'proj_1', { text: 'dúvida qualquer' })

    expect(result.deduped).toBe(false)
    expect(result.question.status).toBe('open')
    expect(prisma.agentQuestion.create).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  test('sem notify injetado: cria normalmente, sem lançar (notify é opcional)', async () => {
    const prisma = fakePrisma()
    const svc = new AgentQuestionService(prisma as any)

    await expect(svc.ask('user_1', 'proj_1', { text: 'dúvida qualquer' })).resolves.toMatchObject({
      deduped: false,
    })
  })
})
