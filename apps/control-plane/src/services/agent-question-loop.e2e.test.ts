import { describe, expect, it, vi } from 'vitest'
import type { CortexDrawer } from '@gitorch/cortex'
import { AgentQuestionService } from './agent-question.js'
import { handleTelegramCallback, type TelegramCallbackDeps } from './telegram-bot.js'

// Prova real (W3.5.2): o loop human-in-the-loop INTEIRO, de ponta a ponta,
// backend — criar dúvida → clique no Telegram → answered + memória (Cortex) —
// sem rede real. Fakes SÓ na borda: a chamada HTTP do Telegram
// (answerTelegramCallback, via fetchImpl) e o Cortex; o resto (
// AgentQuestionService.ask/answer + handleTelegramCallback, com o guard
// cross-tenant) é o código de PRODUÇÃO de verdade — mesmo padrão de fake de
// prisma/cortex/fetch de services/telegram-bot.test.ts e
// services/agent-question.test.ts, espelhado aqui.

const BOT_TOKEN = 'SEGREDO_DO_BOT_FAKE'
const OWNER_ID = 'owner_1'
const OWNER_CHAT_ID = '12345'
const OUTRO_CHAT_ID = '99999'

/* eslint-disable @typescript-eslint/no-explicit-any */

// Fake de prisma cobrindo os 4 pontos reais que o loop toca:
// agentQuestion (ask via findFirst/create, answer via findUnique+update,
// callback via findUnique), event (ask), telegramLink (o guard do callback).
// Mesmo padrão de agent-question.test.ts (store em memória, nunca banco real).
function fakePrisma() {
  const questions = new Map<string, any>()
  const events: any[] = []
  const projects = new Map<string, { id: string; wingId: string }>()
  const telegramLinks = new Map<string, any>()
  let seq = 0

  return {
    questions,
    events,
    projects,
    telegramLinks,
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
    },
    event: {
      create: vi.fn(async ({ data }: any) => {
        const rec = { id: `e_${++seq}`, createdAt: new Date(), ...data }
        events.push(rec)
        return rec
      }),
    },
    telegramLink: {
      findUnique: vi.fn(async ({ where }: any) => telegramLinks.get(where.userId) ?? null),
    },
  }
}

function fakeCortex() {
  return { writeDrawer: vi.fn(async (_drawer: CortexDrawer) => undefined) }
}

// A dúvida real das cores (a mesma da rota dev — ver routes/dev-agent-question.ts).
const COR_AZUL_QUESTION = {
  text: 'As páginas Home, Preço e Painel usam 3 azuis diferentes. Qual é o azul oficial do site?',
  options: [
    { label: '#2563EB', value: '#2563EB' },
    { label: '#1E40AF', value: '#1E40AF' },
    { label: '#3B82F6', value: '#3B82F6' },
  ],
  dedupKey: 'cor-azul-oficial',
}

describe('Loop human-in-the-loop E2E (W3.5.2) — criar dúvida → clique → answered + memória', () => {
  it('PROVA: cria a dúvida das cores, clique do DONO no Telegram vira answered + grava a decisão no Cortex', async () => {
    const prisma = fakePrisma()
    // owner + projeto do owner (wingId é o que answer() usa pra gravar no
    // Cortex — ver AgentQuestionService.answer/buildDecisionDrawer).
    prisma.projects.set('proj_1', { id: 'proj_1', wingId: 'octo/repo' })
    // TelegramLink { userId, status:'linked', chatId } — o vínculo que o
    // guard cross-tenant de handleTelegramCallback exige.
    prisma.telegramLinks.set(OWNER_ID, {
      userId: OWNER_ID,
      status: 'linked',
      chatId: OWNER_CHAT_ID,
    })

    const cortex = fakeCortex()
    const agentQuestionService = new AgentQuestionService(prisma as any, { cortex })

    // 1) Cria a dúvida (mesmo caminho da rota dev — AgentQuestionService.ask).
    const created = await agentQuestionService.ask(OWNER_ID, 'proj_1', COR_AZUL_QUESTION)
    expect(created.deduped).toBe(false)
    expect(created.question.status).toBe('open')
    const questionId = created.question.id

    // 2) Simula o CLIQUE: callback_query do chat vinculado ao dono, na 1ª
    // opção (#2563EB). answerTelegramCallback (a chamada de rede) é faked via
    // fetchImpl — sem rede real.
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    ) as unknown as typeof fetch
    const deps: TelegramCallbackDeps = {
      prisma: prisma as any,
      agentQuestionService,
      botToken: BOT_TOKEN,
      fetchImpl,
    }

    await handleTelegramCallback(deps, {
      update_id: 1,
      callback_query: {
        id: 'cbq_1',
        from: { id: Number(OWNER_CHAT_ID) },
        data: `q:${questionId}:0`,
      },
    })

    // 3) A PROVA: a AgentQuestion virou answered com o value certo, pela via
    // 'telegram' — e a decisão foi gravada na memória de longo prazo (Cortex).
    const answered = prisma.questions.get(questionId)
    expect(answered.status).toBe('answered')
    expect(answered.answer).toBe('#2563EB')
    expect(answered.answeredVia).toBe('telegram')

    expect(cortex.writeDrawer).toHaveBeenCalledTimes(1)
    const drawer = cortex.writeDrawer.mock.calls[0]![0]
    expect(drawer.wingId).toBe('octo/repo')
    expect(drawer.content).toContain(COR_AZUL_QUESTION.text)
    expect(drawer.content).toContain('#2563EB')

    // O bot respondeu ao Telegram (o spinner do botão some no celular).
    const answerCallbackCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => String(c[0]).includes('/answerCallbackQuery')
    )
    expect(answerCallbackCall).toBeTruthy()
  })

  it('GUARD cross-tenant: clique de um chat que NÃO é o do dono não responde nem grava nada', async () => {
    const prisma = fakePrisma()
    prisma.projects.set('proj_1', { id: 'proj_1', wingId: 'octo/repo' })
    prisma.telegramLinks.set(OWNER_ID, {
      userId: OWNER_ID,
      status: 'linked',
      chatId: OWNER_CHAT_ID,
    })

    const cortex = fakeCortex()
    const agentQuestionService = new AgentQuestionService(prisma as any, { cortex })
    const created = await agentQuestionService.ask(OWNER_ID, 'proj_1', COR_AZUL_QUESTION)
    const questionId = created.question.id

    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    ) as unknown as typeof fetch
    const deps: TelegramCallbackDeps = {
      prisma: prisma as any,
      agentQuestionService,
      botToken: BOT_TOKEN,
      fetchImpl,
    }

    // Alguém que NÃO é o dono (chat diferente) tenta responder a MESMA dúvida.
    await handleTelegramCallback(deps, {
      update_id: 2,
      callback_query: {
        id: 'cbq_2',
        from: { id: Number(OUTRO_CHAT_ID) },
        data: `q:${questionId}:0`,
      },
    })

    const stillOpen = prisma.questions.get(questionId)
    expect(stillOpen.status).toBe('open')
    expect(stillOpen.answer).toBeNull()
    expect(cortex.writeDrawer).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
