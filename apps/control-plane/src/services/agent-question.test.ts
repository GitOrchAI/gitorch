import { describe, expect, test, vi } from 'vitest'
import type { CortexDrawer } from '@gitorch/cortex'
import { AgentQuestionService } from './agent-question.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
// Fake do Prisma para agent_questions + events: store em memória com os
// métodos que o serviço usa. Mesmo padrão de environment.test.ts/
// engine-connection.test.ts — NUNCA banco real. `projects` simula o join
// (`include: { project: ... }`) que answer() usa pra achar o wingId.
function fakePrisma() {
  const questions = new Map<string, any>()
  const events: any[] = []
  const projects = new Map<string, { id: string; wingId: string }>()
  let seq = 0
  return {
    questions,
    events,
    projects,
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
      findUnique: vi.fn(async ({ where, include }: any) => {
        const rec = questions.get(where.id)
        if (!rec) return null
        if (include?.project) {
          return { ...rec, project: projects.get(rec.projectId) ?? null }
        }
        return rec
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
          if (where?.status !== undefined && r.status !== where.status) return false
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

describe('AgentQuestionService.answer (W3.2.3)', () => {
  function fakeCortex() {
    return { writeDrawer: vi.fn(async (_drawer: CortexDrawer) => undefined) }
  }

  test('grava answer/answeredAt/answeredVia + status answered, e registra a decisão no Cortex', async () => {
    const prisma = fakePrisma()
    prisma.projects.set('proj_1', { id: 'proj_1', wingId: 'octo/repo' })
    prisma.questions.set('q_1', {
      id: 'q_1',
      projectId: 'proj_1',
      userId: 'user_1',
      text: 'Qual é o azul oficial do site?',
      dedupKey: 'cor-oficial-site',
      status: 'open',
      options: [],
      answer: null,
      answeredAt: null,
      answeredVia: null,
      createdAt: new Date('2026-07-21T10:00:00Z'),
      updatedAt: new Date('2026-07-21T10:00:00Z'),
    })
    const cortex = fakeCortex()
    const now = new Date('2026-07-21T12:00:00Z')
    const svc = new AgentQuestionService(prisma as any, { cortex, now: () => now })

    const result = await svc.answer('q_1', '#2563EB', 'telegram')

    expect(result?.status).toBe('answered')
    expect(result?.answer).toBe('#2563EB')
    expect(result?.answeredAt).toEqual(now)
    expect(result?.answeredVia).toBe('telegram')
    expect(prisma.questions.get('q_1')?.status).toBe('answered')

    expect(cortex.writeDrawer).toHaveBeenCalledTimes(1)
    const drawer = cortex.writeDrawer.mock.calls[0]![0]
    expect(drawer.wingId).toBe('octo/repo')
    expect(drawer.content).toContain('Qual é o azul oficial do site?')
    expect(drawer.content).toContain('#2563EB')
    expect(drawer.tags).toEqual(expect.arrayContaining(['decisao', 'rumo', 'agent-question']))
  })

  test('idempotente: responder 2x NÃO regrava nem duplica a memória', async () => {
    const prisma = fakePrisma()
    prisma.projects.set('proj_1', { id: 'proj_1', wingId: 'octo/repo' })
    prisma.questions.set('q_1', {
      id: 'q_1',
      projectId: 'proj_1',
      userId: 'user_1',
      text: 'Qual é o azul oficial?',
      status: 'open',
      options: [],
      answer: null,
      answeredAt: null,
      answeredVia: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const cortex = fakeCortex()
    const svc = new AgentQuestionService(prisma as any, { cortex })

    const first = await svc.answer('q_1', '#2563EB', 'telegram')
    const second = await svc.answer('q_1', '#1E40AF', 'panel')

    expect(cortex.writeDrawer).toHaveBeenCalledTimes(1)
    // a 2ª chamada não muda nada — devolve o estado já respondido intocado
    expect(second?.answer).toBe(first?.answer)
    expect(second?.answeredVia).toBe(first?.answeredVia)
    expect(prisma.agentQuestion.update).toHaveBeenCalledTimes(1)
  })

  test('falha do Cortex (best-effort) NÃO desfaz o answer — o banco é a fonte de verdade', async () => {
    const prisma = fakePrisma()
    prisma.projects.set('proj_1', { id: 'proj_1', wingId: 'octo/repo' })
    prisma.questions.set('q_1', {
      id: 'q_1',
      projectId: 'proj_1',
      userId: 'user_1',
      text: 'dúvida',
      status: 'open',
      options: [],
      answer: null,
      answeredAt: null,
      answeredVia: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const cortex = {
      writeDrawer: vi.fn(async () => {
        throw new Error('cortex indisponível')
      }),
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const svc = new AgentQuestionService(prisma as any, { cortex })

    const result = await svc.answer('q_1', '#2563EB', 'telegram')

    expect(result?.status).toBe('answered')
    expect(result?.answer).toBe('#2563EB')
    expect(warnSpy).toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  test('sem cortex injetado: grava o answer normalmente, sem lançar', async () => {
    const prisma = fakePrisma()
    prisma.projects.set('proj_1', { id: 'proj_1', wingId: 'octo/repo' })
    prisma.questions.set('q_1', {
      id: 'q_1',
      projectId: 'proj_1',
      userId: 'user_1',
      text: 'dúvida',
      status: 'open',
      options: [],
      answer: null,
      answeredAt: null,
      answeredVia: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const svc = new AgentQuestionService(prisma as any)

    const result = await svc.answer('q_1', 'valor', 'panel')

    expect(result?.status).toBe('answered')
  })

  test('questionId inexistente: devolve null sem lançar', async () => {
    const prisma = fakePrisma()
    const svc = new AgentQuestionService(prisma as any)

    const result = await svc.answer('nao-existe', 'valor', 'panel')

    expect(result).toBeNull()
    expect(prisma.agentQuestion.update).not.toHaveBeenCalled()
  })
})

describe('AgentQuestionService.listForUser / listOpen (W3.2.3)', () => {
  test('listForUser: devolve as dúvidas do dono, abertas primeiro, depois por createdAt (mais recente primeiro)', async () => {
    const prisma = fakePrisma()
    prisma.questions.set('answered_novo', {
      id: 'answered_novo',
      projectId: 'proj_1',
      userId: 'user_1',
      text: 'a',
      status: 'answered',
      options: [],
      createdAt: new Date('2026-07-20T10:00:00Z'),
    })
    prisma.questions.set('open_velho', {
      id: 'open_velho',
      projectId: 'proj_1',
      userId: 'user_1',
      text: 'b',
      status: 'open',
      options: [],
      createdAt: new Date('2026-07-18T10:00:00Z'),
    })
    prisma.questions.set('open_novo', {
      id: 'open_novo',
      projectId: 'proj_1',
      userId: 'user_1',
      text: 'c',
      status: 'open',
      options: [],
      createdAt: new Date('2026-07-21T10:00:00Z'),
    })
    prisma.questions.set('de_outro_dono', {
      id: 'de_outro_dono',
      projectId: 'proj_2',
      userId: 'user_2',
      text: 'd',
      status: 'open',
      options: [],
      createdAt: new Date('2026-07-21T11:00:00Z'),
    })
    const svc = new AgentQuestionService(prisma as any)

    const result = await svc.listForUser('user_1')

    expect(result.map((q) => q.id)).toEqual(['open_novo', 'open_velho', 'answered_novo'])
  })

  test('listOpen: só as abertas do projeto', async () => {
    const prisma = fakePrisma()
    prisma.questions.set('q_open', {
      id: 'q_open',
      projectId: 'proj_1',
      userId: 'user_1',
      text: 'a',
      status: 'open',
      options: [],
      createdAt: new Date(),
    })
    prisma.questions.set('q_answered', {
      id: 'q_answered',
      projectId: 'proj_1',
      userId: 'user_1',
      text: 'b',
      status: 'answered',
      options: [],
      createdAt: new Date(),
    })
    prisma.questions.set('q_other_project', {
      id: 'q_other_project',
      projectId: 'proj_2',
      userId: 'user_2',
      text: 'c',
      status: 'open',
      options: [],
      createdAt: new Date(),
    })
    const svc = new AgentQuestionService(prisma as any)

    const result = await svc.listOpen('proj_1')

    expect(result.map((q) => q.id)).toEqual(['q_open'])
  })
})
