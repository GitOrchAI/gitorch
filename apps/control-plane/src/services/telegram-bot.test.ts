import { describe, expect, it, vi } from 'vitest'
import {
  parseStartToken,
  getTelegramUpdates,
  sendTelegramMessage,
  sendTelegramQuestion,
  answerTelegramCallback,
  parseQuestionCallbackData,
  handleTelegramCallback,
  handleTelegramUpdate,
} from './telegram-bot.js'

// A ponte com a API do Telegram. Aqui mora o único jeito de o bot descobrir o
// `chat_id` de alguém: o update de `/start <token>`, que só chega DEPOIS de a
// pessoa apertar Start. Nada disto pode inventar sucesso, e o token do BOT
// (segredo de infra) nunca pode escapar para uma mensagem ou para um retorno.

const BOT = 'SEGREDO_DO_BOT'

/* eslint-disable @typescript-eslint/no-explicit-any */
function fakePrismaComToken(token: string, userId = 'user_a') {
  const row = {
    id: 'tgl_1',
    userId,
    status: 'pending',
    token,
    tokenExpiresAt: new Date(Date.now() + 60_000),
    chatId: null as string | null,
    linkedAt: null as Date | null,
  }
  return {
    row,
    telegramLink: {
      findUnique: async ({ where }: any) =>
        (where.token !== undefined ? where.token === row.token : where.userId === row.userId)
          ? row
          : null,
      findFirst: async ({ where }: any) => (where.token === row.token ? row : null),
      upsert: async () => row,
      updateMany: async ({ where, data }: any) => {
        if (where.token !== row.token || row.status !== 'pending') return { count: 0 }
        Object.assign(row, data)
        return { count: 1 }
      },
    },
  }
}

describe('parseStartToken — só o /start com token diz quem é a pessoa', () => {
  it('extrai o token do /start', () => {
    expect(parseStartToken('/start abc123')).toBe('abc123')
  })

  it('aceita a forma com o nome do bot (Telegram usa isso em grupo)', () => {
    expect(parseStartToken('/start@GitOrchAI_bot abc123')).toBe('abc123')
  })

  it('tolera espaço extra e quebra de linha (o cliente cola do jeito que vier)', () => {
    expect(parseStartToken('  /start   abc123  \n')).toBe('abc123')
  })

  it('/start pelado não vincula ninguém (não sabemos quem é)', () => {
    expect(parseStartToken('/start')).toBeNull()
  })

  it('conversa qualquer não é comando de vínculo', () => {
    expect(parseStartToken('oi, tudo bem?')).toBeNull()
    expect(parseStartToken(undefined)).toBeNull()
  })
})

describe('getUpdates — ouvir o bot sem depender de URL pública', () => {
  it('avança o offset (senão o mesmo update volta para sempre)', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: [
              { update_id: 10, message: { chat: { id: 5 }, text: '/start t1' } },
              { update_id: 11, message: { chat: { id: 6 }, text: 'oi' } },
            ],
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch

    const result = await getTelegramUpdates({ botToken: BOT, offset: 10, fetchImpl })

    expect(result.updates).toHaveLength(2)
    expect(result.nextOffset).toBe(12) // maior update_id + 1
    expect(result.conflict).toBe(false)
    const url = String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])
    expect(url).toContain('/getUpdates')
    expect(url).toContain('offset=10')
  })

  it('pede allowed_updates=[message,callback_query] — sem isso o Telegram NÃO entrega cliques de botão (W3.3.2)', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })
    ) as unknown as typeof fetch

    await getTelegramUpdates({ botToken: BOT, fetchImpl })

    const url = new URL(
      String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])
    )
    const allowed = JSON.parse(url.searchParams.get('allowed_updates') ?? '[]')
    expect(allowed).toEqual(['message', 'callback_query'])
  })

  it('sem update nenhum, o offset NÃO regride', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })
    ) as unknown as typeof fetch
    const result = await getTelegramUpdates({ botToken: BOT, offset: 42, fetchImpl })
    expect(result.updates).toEqual([])
    expect(result.nextOffset).toBe(42)
  })

  it('409 = outro ouvinte/webhook no mesmo bot — reporta o conflito em vez de fingir silêncio', async () => {
    // Silenciar isto seria o pior dos mundos: o cliente aperta Start, o update
    // vai para o outro ouvinte, e o wizard fica "aguardando" para sempre sem
    // ninguém saber por quê.
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error_code: 409, description: 'Conflict' }), {
          status: 409,
        })
    ) as unknown as typeof fetch

    const result = await getTelegramUpdates({ botToken: BOT, offset: 1, fetchImpl })

    expect(result.conflict).toBe(true)
    expect(result.updates).toEqual([])
    expect(result.nextOffset).toBe(1)
  })

  it('resposta torta não vira update fantasma', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, result: 'nada disso' }), { status: 200 })
    ) as unknown as typeof fetch
    const result = await getTelegramUpdates({ botToken: BOT, fetchImpl })
    expect(result.updates).toEqual([])
  })
})

describe('sendMessage — é o chat_id que endereça, não o @username', () => {
  it('manda para o chat_id capturado no Start', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    ) as unknown as typeof fetch

    const ok = await sendTelegramMessage({
      botToken: BOT,
      chatId: '555',
      text: 'task travada',
      fetchImpl,
    })

    expect(ok).toBe(true)
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(call?.[0])).toContain('/sendMessage')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ chat_id: '555', text: 'task travada' })
  })

  it('falha do Telegram é falha (não devolve "true" de consolo)', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: false }), { status: 400 })
    ) as unknown as typeof fetch
    expect(await sendTelegramMessage({ botToken: BOT, chatId: '5', text: 'x', fetchImpl })).toBe(
      false
    )
  })

  it('rede fora não derruba a esteira', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    expect(await sendTelegramMessage({ botToken: BOT, chatId: '5', text: 'x', fetchImpl })).toBe(
      false
    )
  })
})

describe('sendTelegramQuestion — a dúvida do agente vira botões (W3.3.1)', () => {
  it('monta um inline_keyboard com callback_data "q:<id>:<índice>" (não o value — cabe em 64 bytes)', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 })
    ) as unknown as typeof fetch

    await sendTelegramQuestion({
      botToken: BOT,
      chatId: '555',
      questionId: 'q_abc123',
      text: 'Qual é o azul oficial do site?',
      options: [
        { label: '#2563EB', value: '#2563EB' },
        { label: '#1E40AF', value: '#1E40AF' },
      ],
      fetchImpl,
    })

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(call?.[0])).toContain('/sendMessage')
    const body = JSON.parse(String(call?.[1]?.body))
    expect(body.chat_id).toBe('555')
    expect(body.text).toBe('Qual é o azul oficial do site?')
    expect(body.reply_markup.inline_keyboard).toEqual([
      [
        { text: '#2563EB', callback_data: 'q:q_abc123:0' },
        { text: '#1E40AF', callback_data: 'q:q_abc123:1' },
      ],
    ])
  })

  it('sem opções: manda só o texto (pergunta aberta), sem reply_markup', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 })
    ) as unknown as typeof fetch

    await sendTelegramQuestion({
      botToken: BOT,
      chatId: '555',
      questionId: 'q_aberta',
      text: 'Descreva em texto livre...',
      options: [],
      fetchImpl,
    })

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse(String(call?.[1]?.body))
    expect(body).toEqual({ chat_id: '555', text: 'Descreva em texto livre...' })
    expect(body.reply_markup).toBeUndefined()
  })

  it('devolve o message_id da resposta (pro telegramMessageId da AgentQuestion)', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }), { status: 200 })
    ) as unknown as typeof fetch

    const messageId = await sendTelegramQuestion({
      botToken: BOT,
      chatId: '555',
      questionId: 'q_x',
      text: 'oi',
      options: [],
      fetchImpl,
    })

    expect(messageId).toBe(999)
  })

  it('labels longos: 1 botão por linha (decisão simples de layout)', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
    ) as unknown as typeof fetch

    await sendTelegramQuestion({
      botToken: BOT,
      chatId: '555',
      questionId: 'q_y',
      text: 'Qual opção?',
      options: [
        { label: 'Manter o azul #2563EB em todas as páginas', value: 'a' },
        { label: 'Trocar tudo para o #1E40AF do painel', value: 'b' },
      ],
      fetchImpl,
    })

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse(String(call?.[1]?.body))
    expect(body.reply_markup.inline_keyboard).toHaveLength(2) // 1 por linha
    expect(body.reply_markup.inline_keyboard[0]).toHaveLength(1)
  })

  it('callback_data cabe no limite de 64 bytes do Telegram mesmo com um id realista (cuid) e índice de 2 dígitos', () => {
    const realisticId = 'clx1a2b3c4d5e6f7g8h9i0j1' // formato cuid típico
    for (let i = 0; i < 10; i++) {
      const callbackData = `q:${realisticId}:${i}`
      expect(Buffer.byteLength(callbackData, 'utf8')).toBeLessThanOrEqual(64)
    }
  })

  it('falha do Telegram não lança — devolve undefined (best-effort, quem chama trata)', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: false }), { status: 400 })
    ) as unknown as typeof fetch

    const messageId = await sendTelegramQuestion({
      botToken: BOT,
      chatId: '555',
      questionId: 'q_z',
      text: 'oi',
      options: [],
      fetchImpl,
    })

    expect(messageId).toBeUndefined()
  })
})

describe('handleTelegramUpdate — o Start do cliente vira vínculo real', () => {
  it('/start <token> vincula o chat e responde a confirmação NO IDIOMA da pessoa', async () => {
    const prisma = fakePrismaComToken('tok_valido')

    const reply = await handleTelegramUpdate(prisma as any, {
      update_id: 1,
      message: {
        chat: { id: 987654321 },
        text: '/start tok_valido',
        from: { language_code: 'pt-br' },
      },
    })

    expect(prisma.row.status).toBe('linked')
    expect(prisma.row.chatId).toBe('987654321')
    expect(reply?.chatId).toBe('987654321')
    expect(reply?.text.toLowerCase()).toContain('conectado')
    // O segredo do bot NUNCA vai parar numa mensagem.
    expect(reply?.text).not.toContain(BOT)
  })

  it('token inválido responde a verdade (e não vincula nada)', async () => {
    const prisma = fakePrismaComToken('tok_valido')

    const reply = await handleTelegramUpdate(prisma as any, {
      update_id: 2,
      message: { chat: { id: 5 }, text: '/start tok_errado', from: { language_code: 'en' } },
    })

    expect(prisma.row.status).toBe('pending')
    expect(prisma.row.chatId).toBeNull()
    expect(reply?.chatId).toBe('5')
    expect(reply?.text).toBeTruthy()
  })

  it('/start pelado orienta em vez de fingir vínculo', async () => {
    const prisma = fakePrismaComToken('tok_valido')
    const reply = await handleTelegramUpdate(prisma as any, {
      update_id: 3,
      message: { chat: { id: 5 }, text: '/start' },
    })
    expect(prisma.row.status).toBe('pending')
    expect(reply?.text).toBeTruthy()
  })

  it('conversa fiada é ignorada (o bot não é um chatbot)', async () => {
    const prisma = fakePrismaComToken('tok_valido')
    const reply = await handleTelegramUpdate(prisma as any, {
      update_id: 4,
      message: { chat: { id: 5 }, text: 'bom dia' },
    })
    expect(reply).toBeNull()
  })

  it('update sem chat não quebra o laço', async () => {
    const prisma = fakePrismaComToken('tok_valido')
    expect(await handleTelegramUpdate(prisma as any, { update_id: 5 })).toBeNull()
  })
})

describe('answerTelegramCallback — some o "carregando" do botão no celular do dono (W3.3.2)', () => {
  it('chama answerCallbackQuery com o id do callback e o texto', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    ) as unknown as typeof fetch

    const ok = await answerTelegramCallback({
      botToken: BOT,
      callbackQueryId: 'cbq_1',
      text: '✓ registrado',
      fetchImpl,
    })

    expect(ok).toBe(true)
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(call?.[0])).toContain('/answerCallbackQuery')
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      callback_query_id: 'cbq_1',
      text: '✓ registrado',
    })
  })

  it('falha do Telegram é falha (não finge sucesso)', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: false }), { status: 400 })
    ) as unknown as typeof fetch
    expect(
      await answerTelegramCallback({ botToken: BOT, callbackQueryId: 'cbq_2', fetchImpl })
    ).toBe(false)
  })

  it('rede fora não derruba a esteira', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    expect(
      await answerTelegramCallback({ botToken: BOT, callbackQueryId: 'cbq_3', fetchImpl })
    ).toBe(false)
  })
})

describe('parseQuestionCallbackData — "q:<id>:<índice>" sem confiar cegamente no que o Telegram manda', () => {
  it('extrai id e índice do formato válido', () => {
    expect(parseQuestionCallbackData('q:q_abc123:0')).toEqual({
      questionId: 'q_abc123',
      optionIndex: 0,
    })
    expect(parseQuestionCallbackData('q:q_abc123:12')).toEqual({
      questionId: 'q_abc123',
      optionIndex: 12,
    })
  })

  it('formatos inválidos não quebram — devolvem null', () => {
    expect(parseQuestionCallbackData(undefined)).toBeNull()
    expect(parseQuestionCallbackData('')).toBeNull()
    expect(parseQuestionCallbackData('lixo')).toBeNull()
    expect(parseQuestionCallbackData('q:q_abc123')).toBeNull() // sem índice
    expect(parseQuestionCallbackData('q:q_abc123:')).toBeNull() // índice vazio
    expect(parseQuestionCallbackData('q:q_abc123:abc')).toBeNull() // índice não numérico
    expect(parseQuestionCallbackData('q:q_abc123:-1')).toBeNull() // índice negativo
    expect(parseQuestionCallbackData('outra:coisa:0')).toBeNull() // prefixo errado
  })
})

describe('handleTelegramCallback — o clique no botão vira answer(), com guard anti cross-tenant (W3.3.2)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  function fakeDeps(opts: { question?: any; link?: any; fetchOk?: boolean }) {
    const answerCalls: any[] = []
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: opts.fetchOk ?? true }), { status: 200 })
    ) as unknown as typeof fetch
    const deps = {
      prisma: {
        agentQuestion: {
          findUnique: vi.fn(async ({ where }: any) =>
            opts.question && where.id === opts.question.id ? opts.question : null
          ),
        },
        telegramLink: {
          findUnique: vi.fn(async ({ where }: any) =>
            opts.link && where.userId === opts.link.userId ? opts.link : null
          ),
        },
      },
      agentQuestionService: {
        answer: vi.fn(async (id: string, value: string, via: string) => {
          answerCalls.push({ id, value, via })
          return null
        }),
      },
      botToken: BOT,
      fetchImpl,
    }
    return { deps, answerCalls, fetchImpl }
  }

  const QUESTION = {
    id: 'q_1',
    userId: 'user_dono',
    options: [
      { label: '#2563EB', value: '#2563EB' },
      { label: '#1E40AF', value: '#1E40AF' },
    ],
  }
  const LINK_DONO = { userId: 'user_dono', status: 'linked', chatId: '555' }

  it('clique válido (chat do DONO): resolve o value pelo índice, chama answer() e answerCallbackQuery', async () => {
    const { deps, answerCalls, fetchImpl } = fakeDeps({ question: QUESTION, link: LINK_DONO })

    await handleTelegramCallback(deps as any, {
      update_id: 1,
      callback_query: { id: 'cbq_1', from: { id: 555 }, data: 'q:q_1:1' },
    })

    expect(answerCalls).toEqual([{ id: 'q_1', value: '#1E40AF', via: 'telegram' }])
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('/answerCallbackQuery')
    )
    expect(call).toBeTruthy()
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ callback_query_id: 'cbq_1' })
  })

  it('GUARD cross-tenant: chat que não é o do dono da questão → IGNORA (answer NÃO chamado, nada responde)', async () => {
    const { deps, answerCalls, fetchImpl } = fakeDeps({ question: QUESTION, link: LINK_DONO })

    await handleTelegramCallback(deps as any, {
      update_id: 2,
      // 999 não é o chat_id (555) vinculado ao dono (user_dono) da questão.
      callback_query: { id: 'cbq_2', from: { id: 999 }, data: 'q:q_1:0' },
    })

    expect(answerCalls).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sem vínculo (ninguém apertou Start) → ignora, não vaza nem responde', async () => {
    const { deps, answerCalls, fetchImpl } = fakeDeps({ question: QUESTION, link: undefined })

    await handleTelegramCallback(deps as any, {
      update_id: 3,
      callback_query: { id: 'cbq_3', from: { id: 555 }, data: 'q:q_1:0' },
    })

    expect(answerCalls).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('callback_data em formato inválido → ignora (parse robusto)', async () => {
    const { deps, answerCalls, fetchImpl } = fakeDeps({ question: QUESTION, link: LINK_DONO })

    await handleTelegramCallback(deps as any, {
      update_id: 4,
      callback_query: { id: 'cbq_4', from: { id: 555 }, data: 'formato-invalido' },
    })

    expect(answerCalls).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('índice fora do range das opções → ignora', async () => {
    const { deps, answerCalls, fetchImpl } = fakeDeps({ question: QUESTION, link: LINK_DONO })

    await handleTelegramCallback(deps as any, {
      update_id: 5,
      callback_query: { id: 'cbq_5', from: { id: 555 }, data: 'q:q_1:99' },
    })

    expect(answerCalls).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('questão inexistente → ignora', async () => {
    const { deps, answerCalls, fetchImpl } = fakeDeps({ question: undefined, link: LINK_DONO })

    await handleTelegramCallback(deps as any, {
      update_id: 6,
      callback_query: { id: 'cbq_6', from: { id: 555 }, data: 'q:q_1:0' },
    })

    expect(answerCalls).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('update sem callback_query (mensagem normal) não faz nada', async () => {
    const { deps, answerCalls, fetchImpl } = fakeDeps({ question: QUESTION, link: LINK_DONO })

    await handleTelegramCallback(deps as any, { update_id: 7, message: { text: 'oi' } })

    expect(answerCalls).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
