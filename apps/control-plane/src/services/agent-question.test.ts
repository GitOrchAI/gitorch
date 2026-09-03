import { describe, expect, test, vi } from 'vitest'
import type { CortexDrawer } from '@gitorch/cortex'
import { AgentQuestionService, type ManipuladorDeRespostaArgs } from './agent-question.js'
import { chaveDaDuvida } from './duvidas-do-projeto.js'
import { comoPublicaDeclarado } from './como-o-projeto-publica.js'

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
          if (where.id !== undefined && r.id !== where.id) return false
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
    // A resposta do dono vira configuração do projeto (D49) — antes ela
    // morria na tabela de dúvidas e ninguém a lia de volta.
    project: {
      findUnique: vi.fn(async ({ where }: any) => projects.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const rec = { ...projects.get(where.id), ...data }
        projects.set(where.id, rec as any)
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

describe('a resposta do dono vira configuração do projeto (D49)', () => {
  test('responder "publico em VM própria" grava a declaração no projeto', async () => {
    const prisma = fakePrisma()
    prisma.projects.set('p1', {
      id: 'p1',
      wingId: 'acme/api',
      runtimeConfig: { motores: { principal: 'claude' } },
    } as any)
    const svc = new AgentQuestionService(prisma as any)

    const { question } = await svc.ask('u1', 'p1', {
      dedupKey: chaveDaDuvida('como-publica', 'acme/api'),
      text: 'Como o acme/api chega ao ar?',
      context: '',
      options: [{ label: 'Servidor meu', value: 'publica-em-vm-propria' }],
    })

    await svc.answer(question.id, 'publica-em-vm-propria', 'telegram')

    const projeto = prisma.projects.get('p1') as any
    expect(comoPublicaDeclarado(projeto.runtimeConfig)).toBe('publica-em-vm-propria')
    // O resto da configuração continua de pé: mesclar, nunca substituir.
    expect(projeto.runtimeConfig.motores).toEqual({ principal: 'claude' })
  })

  test('a resposta de outra dúvida não mexe na configuração do projeto', async () => {
    const prisma = fakePrisma()
    prisma.projects.set('p1', { id: 'p1', wingId: 'acme/api', runtimeConfig: {} } as any)
    const svc = new AgentQuestionService(prisma as any)

    const { question } = await svc.ask('u1', 'p1', {
      dedupKey: chaveDaDuvida('sem-verificacao', 'acme/api'),
      text: 'E a verificação?',
      context: '',
      options: [{ label: 'Vai ganhar', value: 'vai-ganhar-verificacao' }],
    })
    await svc.answer(question.id, 'vai-ganhar-verificacao', 'telegram')

    expect(prisma.project.update).not.toHaveBeenCalled()
  })
})

// L4-T2 (D63): quando a dúvida respondida é sobre uma automação do cliente
// que falhou (dedupKey `automacao:<repo>:<identidade>`), a resposta vira
// AÇÃO (deletar/reajustar/manter/texto livre) — injetada, para
// AgentQuestionService continuar sem saber nada de GitHub/PR. C4 (fix-up
// L4-T2): a ação roda ANTES de marcar `answered`, e uma falha dela IMPEDE o
// `answer` — nada de best-effort aqui (ao contrário do Cortex/config acima).
describe('a resposta do dono aciona a decisão de automação (L4-T2 / C4)', () => {
  test('dedupKey automacao: → chama aoResponderAutomacao com dedupKey/resposta/projectId/autonomia (SEM context)', async () => {
    const prisma = fakePrisma()
    prisma.projects.set('p1', { id: 'p1', wingId: 'acme/api', autonomia: 'cuidar' } as any)
    prisma.questions.set('q_auto', {
      id: 'q_auto',
      projectId: 'p1',
      userId: 'u1',
      text: 'O que fazer?',
      context: 'dispara em "push" · proposta #901 · arquivo:.github/workflows/x.yml',
      dedupKey: 'automacao:acme/api:wf:40',
      status: 'open',
      options: [],
      answer: null,
      answeredAt: null,
      answeredVia: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const aoResponderAutomacao = vi.fn(async (_args: ManipuladorDeRespostaArgs) => undefined)
    // A1 (fix-up L4-T3): registro por prefixo — substitui o dep fixo
    // `aoResponderAutomacao` por uma entrada em `manipuladoresDeResposta`.
    const svc = new AgentQuestionService(prisma as any, {
      manipuladoresDeResposta: [{ prefixo: 'automacao:', executar: aoResponderAutomacao }],
    })

    const result = await svc.answer('q_auto', 'deletar', 'telegram')

    expect(aoResponderAutomacao).toHaveBeenCalledOnce()
    const chamada = aoResponderAutomacao.mock.calls[0]![0]
    // A2 (fix-up L4-T2): NUNCA `context` — `processarRespostaDeAutomacao`
    // resolve pela dedupKey/infra_incidents, não reparseando texto do dono.
    // A1 (fix-up L4-T3): o args agora é o bag COMUM a todo manipulador —
    // inclui `opcoes` mesmo para quem não usa (aqui vazio, fixture sem
    // opções) — o handler real ignora o que não precisa.
    // S1 (fix-up 2, CSO): também inclui `userId` — este manipulador não usa
    // (só `projectId`/`autonomia`), mas o bag é comum a todos.
    expect(chamada).toEqual({
      dedupKey: 'automacao:acme/api:wf:40',
      resposta: 'deletar',
      projectId: 'p1',
      userId: 'u1',
      autonomia: 'cuidar',
      opcoes: [],
    })
    expect(result?.status).toBe('answered')
  })

  test('C4: aoResponderAutomacao roda ANTES de marcar a pergunta answered', async () => {
    const prisma = fakePrisma()
    prisma.projects.set('p1', { id: 'p1', wingId: 'acme/api', autonomia: 'cuidar' } as any)
    prisma.questions.set('q_auto', {
      id: 'q_auto',
      projectId: 'p1',
      userId: 'u1',
      text: 'O que fazer?',
      dedupKey: 'automacao:acme/api:wf:40',
      status: 'open',
      options: [],
      answer: null,
      answeredAt: null,
      answeredVia: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const aoResponderAutomacao = vi.fn(async () => {
      // No momento em que a ação roda, a pergunta AINDA tem que estar open.
      expect(prisma.questions.get('q_auto')!.status).toBe('open')
    })
    const svc = new AgentQuestionService(prisma as any, {
      manipuladoresDeResposta: [{ prefixo: 'automacao:', executar: aoResponderAutomacao }],
    })

    await svc.answer('q_auto', 'deletar', 'telegram')

    expect(aoResponderAutomacao).toHaveBeenCalledOnce()
    const ordemAcao = aoResponderAutomacao.mock.invocationCallOrder[0]!
    const ordemUpdate = (prisma.agentQuestion.update as any).mock.invocationCallOrder[0]
    expect(ordemAcao).toBeLessThan(ordemUpdate)
  })

  test('dedupKey que NÃO é de automação → aoResponderAutomacao nunca é chamado', async () => {
    const prisma = fakePrisma()
    prisma.projects.set('p1', { id: 'p1', wingId: 'acme/api', autonomia: 'cuidar' } as any)
    prisma.questions.set('q_1', {
      id: 'q_1',
      projectId: 'p1',
      userId: 'u1',
      text: 'dúvida qualquer',
      dedupKey: 'como-publica:acme/api',
      status: 'open',
      options: [],
      answer: null,
      answeredAt: null,
      answeredVia: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const aoResponderAutomacao = vi.fn(async () => undefined)
    const svc = new AgentQuestionService(prisma as any, {
      manipuladoresDeResposta: [{ prefixo: 'automacao:', executar: aoResponderAutomacao }],
    })

    await svc.answer('q_1', 'qualquer', 'panel')

    expect(aoResponderAutomacao).not.toHaveBeenCalled()
  })

  test('C4: falha em aoResponderAutomacao → a pergunta continua open, o erro é logado pelo logger injetado, e answer() lança', async () => {
    const prisma = fakePrisma()
    prisma.projects.set('p1', { id: 'p1', wingId: 'acme/api', autonomia: 'sugerir' } as any)
    prisma.questions.set('q_auto', {
      id: 'q_auto',
      projectId: 'p1',
      userId: 'u1',
      text: 'O que fazer?',
      dedupKey: 'automacao:acme/api:wf:1',
      status: 'open',
      options: [],
      answer: null,
      answeredAt: null,
      answeredVia: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const aoResponderAutomacao = vi.fn(async () => {
      throw new Error('GitHub fora do ar')
    })
    const onError = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const svc = new AgentQuestionService(prisma as any, {
      manipuladoresDeResposta: [{ prefixo: 'automacao:', executar: aoResponderAutomacao }],
      onError,
    })

    await expect(svc.answer('q_auto', 'manter', 'telegram')).rejects.toThrow('GitHub fora do ar')

    // A pergunta NÃO foi marcada answered — nada foi gravado.
    expect(prisma.questions.get('q_auto')!.status).toBe('open')
    expect(prisma.agentQuestion.update).not.toHaveBeenCalled()
    // Logado pelo logger INJETADO — nunca console.warn. (Não assume
    // `warnSpy` zero chamadas no total: outro teste deste arquivo aciona o
    // console.warn REAL de um caminho não relacionado; o que importa aqui é
    // que ESTA falha especificamente não passou por ele.)
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0]![0]).toContain('GitHub fora do ar')
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('decisão de automação'))).toBe(
      false
    )
    warnSpy.mockRestore()
  })
})

// L4-T3 (item 3): a resposta do DONO a uma dúvida do dev assíncrono
// (dedupKey `duvida-dev:<repo>:<issue>:<hash>`, criada por
// `escalar-duvida-ao-dono.ts`) precisa RETOMAR a sessão dele —
// `retomar-sessao-com-resposta.ts` faz o trabalho; aqui só se prova a
// ligação em `answer()`, MESMA disciplina de `aoResponderAutomacao` (ação
// antes de gravar `answered`; falha mantém a pergunta `open`).
describe('a resposta do dono retoma a sessão do dev assíncrono (L4-T3)', () => {
  test('dedupKey duvida-dev: → chama aoResponderDuvidaDoDev com dedupKey/resposta/opcoes', async () => {
    const prisma = fakePrisma()
    prisma.projects.set('p1', { id: 'p1', wingId: 'acme/api' } as any)
    prisma.questions.set('q_duvida', {
      id: 'q_duvida',
      projectId: 'p1',
      userId: 'u1',
      text: 'Podemos cobrar taxa extra?',
      dedupKey: 'duvida-dev:acme/api:46:hash123',
      status: 'open',
      options: [
        { label: 'Sim', value: 'sim' },
        { label: 'Não', value: 'nao' },
      ],
      answer: null,
      answeredAt: null,
      answeredVia: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const aoResponderDuvidaDoDev = vi.fn(async (_args: ManipuladorDeRespostaArgs) => undefined)
    // A1 (fix-up L4-T3): registro por prefixo.
    const svc = new AgentQuestionService(prisma as any, {
      manipuladoresDeResposta: [{ prefixo: 'duvida-dev:', executar: aoResponderDuvidaDoDev }],
    })

    const result = await svc.answer('q_duvida', 'sim', 'telegram')

    expect(aoResponderDuvidaDoDev).toHaveBeenCalledOnce()
    // A1 (fix-up L4-T3): o args agora é o bag COMUM — inclui `projectId`
    // (autonomia fica `undefined`, p1 não tem o campo na fixture; `toEqual`
    // trata chave ausente e `undefined` como equivalentes) mesmo este
    // manipulador não usando os dois; ele só lê `opcoes`.
    // S1 (fix-up 2, CSO): agora também inclui `userId` — `aoResponderDuvidaDoDev`
    // passa a usar `projectId`/`userId` da PRÓPRIA pergunta (nunca resolve o
    // projeto pelo nome do repositório, que não é único entre donos).
    expect(aoResponderDuvidaDoDev.mock.calls[0]![0]).toEqual({
      dedupKey: 'duvida-dev:acme/api:46:hash123',
      resposta: 'sim',
      projectId: 'p1',
      userId: 'u1',
      opcoes: [
        { label: 'Sim', value: 'sim' },
        { label: 'Não', value: 'nao' },
      ],
    })
    expect(result?.status).toBe('answered')
  })

  test('aoResponderDuvidaDoDev roda ANTES de marcar a pergunta answered', async () => {
    const prisma = fakePrisma()
    prisma.projects.set('p1', { id: 'p1', wingId: 'acme/api' } as any)
    prisma.questions.set('q_duvida', {
      id: 'q_duvida',
      projectId: 'p1',
      userId: 'u1',
      text: 'x',
      dedupKey: 'duvida-dev:acme/api:46:hash123',
      status: 'open',
      options: [],
      answer: null,
      answeredAt: null,
      answeredVia: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const aoResponderDuvidaDoDev = vi.fn(async () => {
      expect(prisma.questions.get('q_duvida')!.status).toBe('open')
    })
    const svc = new AgentQuestionService(prisma as any, {
      manipuladoresDeResposta: [{ prefixo: 'duvida-dev:', executar: aoResponderDuvidaDoDev }],
    })

    await svc.answer('q_duvida', 'sim', 'telegram')

    const ordemAcao = aoResponderDuvidaDoDev.mock.invocationCallOrder[0]!
    const ordemUpdate = (prisma.agentQuestion.update as any).mock.invocationCallOrder[0]
    expect(ordemAcao).toBeLessThan(ordemUpdate)
  })

  test('dedupKey que NÃO é duvida-dev: → aoResponderDuvidaDoDev nunca é chamado', async () => {
    const prisma = fakePrisma()
    prisma.projects.set('p1', { id: 'p1', wingId: 'acme/api' } as any)
    prisma.questions.set('q_1', {
      id: 'q_1',
      projectId: 'p1',
      userId: 'u1',
      text: 'dúvida qualquer',
      dedupKey: 'automacao:acme/api:wf:1',
      status: 'open',
      options: [],
      answer: null,
      answeredAt: null,
      answeredVia: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const aoResponderDuvidaDoDev = vi.fn(async () => undefined)
    const aoResponderAutomacao = vi.fn(async () => undefined)
    const svc = new AgentQuestionService(prisma as any, {
      manipuladoresDeResposta: [
        { prefixo: 'duvida-dev:', executar: aoResponderDuvidaDoDev },
        { prefixo: 'automacao:', executar: aoResponderAutomacao },
      ],
    })

    await svc.answer('q_1', 'qualquer', 'panel')

    expect(aoResponderDuvidaDoDev).not.toHaveBeenCalled()
  })

  test('falha em aoResponderDuvidaDoDev → a pergunta continua open, onError é chamado, e answer() lança', async () => {
    const prisma = fakePrisma()
    prisma.projects.set('p1', { id: 'p1', wingId: 'acme/api' } as any)
    prisma.questions.set('q_duvida', {
      id: 'q_duvida',
      projectId: 'p1',
      userId: 'u1',
      text: 'x',
      dedupKey: 'duvida-dev:acme/api:46:hash123',
      status: 'open',
      options: [],
      answer: null,
      answeredAt: null,
      answeredVia: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const aoResponderDuvidaDoDev = vi.fn(async () => {
      throw new Error('sessão do Jules fora do ar')
    })
    const onError = vi.fn()
    const svc = new AgentQuestionService(prisma as any, {
      manipuladoresDeResposta: [{ prefixo: 'duvida-dev:', executar: aoResponderDuvidaDoDev }],
      onError,
    })

    await expect(svc.answer('q_duvida', 'sim', 'telegram')).rejects.toThrow(
      'sessão do Jules fora do ar'
    )

    expect(prisma.questions.get('q_duvida')!.status).toBe('open')
    expect(prisma.agentQuestion.update).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0]![0]).toContain('sessão do Jules fora do ar')
  })
})

// A1 (fix-up L4-T3): antes deste registro, cada prefixo novo (`automacao:`,
// `duvida-dev:`) virava mais um `if (dedupKey.startsWith(...))` fixo dentro
// de `answer()` — e a L4-T4/T9/T18 iam abrir o 3º e o 4º. `manipuladoresDeResposta`
// troca isso por uma LISTA: `answer()` escolhe o PRIMEIRO cujo prefixo casa
// e o executa (mesma disciplina de sempre — ação ANTES de marcar `answered`;
// falha lançada mantém a pergunta `open`). Os testes acima (automação/
// duvida-dev) já provam que o comportamento por prefixo continua idêntico;
// os daqui cobrem o mecanismo genérico do registro em si.
describe('A1: manipuladoresDeResposta — registro de manipuladores por prefixo', () => {
  test('dedupKey que não casa com NENHUM prefixo registrado → nenhum manipulador roda, segue para answered', async () => {
    const prisma = fakePrisma()
    prisma.projects.set('p1', { id: 'p1', wingId: 'acme/api' } as any)
    prisma.questions.set('q_1', {
      id: 'q_1',
      projectId: 'p1',
      userId: 'u1',
      text: 'dúvida qualquer',
      dedupKey: 'como-publica:acme/api',
      status: 'open',
      options: [],
      answer: null,
      answeredAt: null,
      answeredVia: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const automacao = vi.fn(async () => undefined)
    const duvidaDev = vi.fn(async () => undefined)
    const svc = new AgentQuestionService(prisma as any, {
      manipuladoresDeResposta: [
        { prefixo: 'automacao:', executar: automacao },
        { prefixo: 'duvida-dev:', executar: duvidaDev },
      ],
    })

    const result = await svc.answer('q_1', 'qualquer', 'panel')

    expect(automacao).not.toHaveBeenCalled()
    expect(duvidaDev).not.toHaveBeenCalled()
    expect(result?.status).toBe('answered')
  })

  test('falha do manipulador (prefixo qualquer) → a pergunta continua open, onError é chamado, e answer() lança', async () => {
    const prisma = fakePrisma()
    prisma.projects.set('p1', { id: 'p1', wingId: 'acme/api' } as any)
    prisma.questions.set('q_1', {
      id: 'q_1',
      projectId: 'p1',
      userId: 'u1',
      text: 'x',
      dedupKey: 'futuro-prefixo:acme/api:1',
      status: 'open',
      options: [],
      answer: null,
      answeredAt: null,
      answeredVia: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const manipulador = vi.fn(async () => {
      throw new Error('boom')
    })
    const onError = vi.fn()
    const svc = new AgentQuestionService(prisma as any, {
      manipuladoresDeResposta: [{ prefixo: 'futuro-prefixo:', executar: manipulador }],
      onError,
    })

    await expect(svc.answer('q_1', 'resp', 'panel')).rejects.toThrow('boom')

    expect(prisma.questions.get('q_1')!.status).toBe('open')
    expect(prisma.agentQuestion.update).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0]![0]).toContain('boom')
  })

  test('ordem: o manipulador executa ANTES de gravar answered (preservado do mecanismo antigo)', async () => {
    const prisma = fakePrisma()
    prisma.projects.set('p1', { id: 'p1', wingId: 'acme/api' } as any)
    prisma.questions.set('q_1', {
      id: 'q_1',
      projectId: 'p1',
      userId: 'u1',
      text: 'x',
      dedupKey: 'futuro-prefixo:acme/api:1',
      status: 'open',
      options: [],
      answer: null,
      answeredAt: null,
      answeredVia: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const manipulador = vi.fn(async () => {
      expect(prisma.questions.get('q_1')!.status).toBe('open')
    })
    const svc = new AgentQuestionService(prisma as any, {
      manipuladoresDeResposta: [{ prefixo: 'futuro-prefixo:', executar: manipulador }],
    })

    await svc.answer('q_1', 'resp', 'panel')

    const ordemAcao = manipulador.mock.invocationCallOrder[0]!
    const ordemUpdate = (prisma.agentQuestion.update as any).mock.invocationCallOrder[0]
    expect(ordemAcao).toBeLessThan(ordemUpdate)
  })

  test('duas entradas cujo prefixo casaria — só a PRIMEIRA da lista executa', async () => {
    const prisma = fakePrisma()
    prisma.projects.set('p1', { id: 'p1', wingId: 'acme/api' } as any)
    prisma.questions.set('q_1', {
      id: 'q_1',
      projectId: 'p1',
      userId: 'u1',
      text: 'x',
      dedupKey: 'duvida-dev:acme/api:46:hash123',
      status: 'open',
      options: [],
      answer: null,
      answeredAt: null,
      answeredVia: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const primeiro = vi.fn(async () => undefined)
    const segundo = vi.fn(async () => undefined)
    const svc = new AgentQuestionService(prisma as any, {
      manipuladoresDeResposta: [
        { prefixo: 'duvida-dev:', executar: primeiro },
        { prefixo: 'duvida-dev:', executar: segundo },
      ],
    })

    await svc.answer('q_1', 'resp', 'panel')

    expect(primeiro).toHaveBeenCalledOnce()
    expect(segundo).not.toHaveBeenCalled()
  })
})

// L4-T4 (D64): o RA formou uma suposição para uma dúvida ESCALADA que o dono
// deixou 24h em silêncio. `marcarAssumida` grava isso — mas NÃO é uma
// resposta do dono (nunca passa pelo registro de manipuladores de
// `answer()`, nunca vira configuração do projeto via `answer()`'s side
// effects): é só o registro de que o produto seguiu sozinho, provisoriamente.
describe('AgentQuestionService.marcarAssumida (L4-T4, D64)', () => {
  test('grava status=assumida, answer=suposição, answeredVia=ra-suposicao, answeredAt', async () => {
    const prisma = fakePrisma()
    prisma.questions.set('q_1', {
      id: 'q_1',
      projectId: 'p1',
      userId: 'u1',
      text: 'Devo usar bcrypt ou argon2?',
      dedupKey: 'duvida-dev:acme/api:93:hash',
      status: 'open',
      options: [],
      answer: null,
      answeredAt: null,
      answeredVia: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const svc = new AgentQuestionService(prisma as any)

    const resultado = await svc.marcarAssumida({
      questionId: 'q_1',
      projectId: 'p1',
      suposicao: 'Vou usar argon2id, o mesmo padrão de src/lib/hash.ts.',
    })

    expect(resultado?.status).toBe('assumida')
    expect(resultado?.answer).toBe('Vou usar argon2id, o mesmo padrão de src/lib/hash.ts.')
    expect(resultado?.answeredVia).toBe('ra-suposicao')
    expect(resultado?.answeredAt).toBeInstanceOf(Date)
  })

  test('NUNCA passa pelo registro de manipuladores de resposta — não é ação do dono', async () => {
    const prisma = fakePrisma()
    prisma.questions.set('q_1', {
      id: 'q_1',
      projectId: 'p1',
      userId: 'u1',
      text: 'x',
      dedupKey: 'duvida-dev:acme/api:93:hash',
      status: 'open',
      options: [],
      answer: null,
      answeredAt: null,
      answeredVia: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const manipulador = vi.fn(async () => undefined)
    const svc = new AgentQuestionService(prisma as any, {
      manipuladoresDeResposta: [{ prefixo: 'duvida-dev:', executar: manipulador }],
    })

    await svc.marcarAssumida({
      questionId: 'q_1',
      projectId: 'p1',
      suposicao: 'suposição qualquer, texto suficiente para passar.',
    })

    expect(manipulador).not.toHaveBeenCalled()
  })

  test('pergunta inexistente devolve null sem lançar', async () => {
    const prisma = fakePrisma()
    const svc = new AgentQuestionService(prisma as any)

    const resultado = await svc.marcarAssumida({
      questionId: 'nao-existe',
      projectId: 'p1',
      suposicao: 'qualquer suposição de teste aqui.',
    })

    expect(resultado).toBeNull()
  })

  // S1 (fix-up 4, CSO): `marcarAssumida` buscava só pela chave primária
  // (`findUnique({ where: { id } })`), sem confirmar que a pergunta
  // pertencia ao `projectId` de quem está chamando — o filtro de projeto
  // existia SÓ no chamador (`marcarAssumidaPorDedupKey`, que resolve o
  // `questionId` a partir de `(projectId, dedupKey)`). Uma chamada direta
  // com um `questionId` de OUTRO projeto ainda seria aceita. Agora
  // `marcarAssumida` também filtra por `projectId`
  // (`findFirst({ where: { id, projectId } })`): pergunta de outro projeto
  // devolve `null`, exatamente como pergunta inexistente — nunca marca.
  test('S1: pergunta de OUTRO projeto não é marcada — devolve null, nunca atualiza', async () => {
    const prisma = fakePrisma()
    prisma.questions.set('q_1', {
      id: 'q_1',
      projectId: 'p1',
      userId: 'u1',
      text: 'Devo usar bcrypt ou argon2?',
      dedupKey: 'duvida-dev:acme/api:93:hash',
      status: 'open',
      options: [],
      answer: null,
      answeredAt: null,
      answeredVia: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const onError = vi.fn()
    const svc = new AgentQuestionService(prisma as any, { onError })

    const resultado = await svc.marcarAssumida({
      questionId: 'q_1',
      projectId: 'p2', // dono/projeto DIFERENTE do dono real da pergunta (p1)
      suposicao: 'suposição de um projeto que não é o dono desta pergunta.',
    })

    expect(resultado).toBeNull()
    expect(prisma.agentQuestion.update).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0]![0]).toContain('q_1')
  })

  // C7 (fix-up 3, task a13a42f8-2953-4259-b41f-3f8cddb304cd): `console.warn`
  // não aparece em nenhum monitoramento — o logger INJETADO (`onError`,
  // mesmo campo que `answer()` já usa) é quem tem que registrar isto.
  test('C7: pergunta inexistente loga pelo onError INJETADO, nunca console.warn', async () => {
    const prisma = fakePrisma()
    const onError = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const svc = new AgentQuestionService(prisma as any, { onError })

    const resultado = await svc.marcarAssumida({
      questionId: 'nao-existe',
      projectId: 'p1',
      suposicao: 'qualquer suposição de teste aqui.',
    })

    expect(resultado).toBeNull()
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0]![0]).toContain('nao-existe')
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('marcarAssumida'))).toBe(false)
    warnSpy.mockRestore()
  })

  test('idempotente: pergunta já answered (o dono respondeu antes do RA terminar) NÃO é sobrescrita', async () => {
    const prisma = fakePrisma()
    prisma.questions.set('q_1', {
      id: 'q_1',
      projectId: 'p1',
      userId: 'u1',
      text: 'x',
      dedupKey: null,
      status: 'answered',
      options: [],
      answer: 'decisão real do dono',
      answeredAt: new Date('2026-01-01T00:00:00.000Z'),
      answeredVia: 'panel',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const svc = new AgentQuestionService(prisma as any)

    const resultado = await svc.marcarAssumida({
      questionId: 'q_1',
      projectId: 'p1',
      suposicao: 'suposição do RA, que chegou tarde demais.',
    })

    expect(resultado?.answer).toBe('decisão real do dono')
    expect(resultado?.answeredVia).toBe('panel')
    expect(prisma.agentQuestion.update).not.toHaveBeenCalled()
  })

  test('idempotente: já assumida antes NÃO regrava (segunda tentativa do mesmo ciclo)', async () => {
    const prisma = fakePrisma()
    prisma.questions.set('q_1', {
      id: 'q_1',
      projectId: 'p1',
      userId: 'u1',
      text: 'x',
      dedupKey: null,
      status: 'assumida',
      options: [],
      answer: 'primeira suposição',
      answeredAt: new Date('2026-01-01T00:00:00.000Z'),
      answeredVia: 'ra-suposicao',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const svc = new AgentQuestionService(prisma as any)

    const resultado = await svc.marcarAssumida({
      questionId: 'q_1',
      projectId: 'p1',
      suposicao: 'segunda suposição, diferente da primeira.',
    })

    expect(resultado?.answer).toBe('primeira suposição')
    expect(prisma.agentQuestion.update).not.toHaveBeenCalled()
  })
})
