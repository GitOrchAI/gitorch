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
  handleTelegramQuestionReply,
  collapseTelegramQuestion,
  fecharPerguntaNoTelegramAoResponderPeloPainel,
  buildFreeTextOption,
  FREE_TEXT_OPTION_VALUE,
  acharProjeto,
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

// Um chat que JÁ é de outra conta (linha `dono`) e um vínculo pendente
// tentando tomá-lo (linha `novo`). O `updateMany` explode de propósito: se a
// guarda falhar, o teste acusa a escrita em vez de passar em silêncio.
function fakePrismaChatOcupado(token: string) {
  const dono = {
    id: 'tgl_dono',
    userId: 'user_a',
    status: 'linked',
    token: null as string | null,
    tokenExpiresAt: null as Date | null,
    chatId: '555' as string | null,
    linkedAt: new Date(),
  }
  const novo = {
    id: 'tgl_novo',
    userId: 'user_b',
    status: 'pending',
    token: token as string | null,
    tokenExpiresAt: new Date(Date.now() + 60_000) as Date | null,
    chatId: null as string | null,
    linkedAt: null as Date | null,
  }
  const rows = [dono, novo]
  const casa = (r: (typeof rows)[number], where: any): boolean => {
    if (where.token !== undefined && r.token !== where.token) return false
    if (where.userId !== undefined && r.userId !== where.userId) return false
    if (where.status !== undefined && r.status !== where.status) return false
    if (where.chatId !== undefined && r.chatId !== where.chatId) return false
    if (where.NOT?.userId !== undefined && r.userId === where.NOT.userId) return false
    return true
  }
  return {
    dono,
    novo,
    telegramLink: {
      findUnique: async ({ where }: any) => rows.find((r) => casa(r, where)) ?? null,
      findFirst: async ({ where }: any) => rows.find((r) => casa(r, where)) ?? null,
      findMany: async ({ where }: any = {}) => rows.filter((r) => casa(r, where ?? {})),
      upsert: async () => novo,
      updateMany: async () => {
        throw new Error('não pode vincular: este chat já é de outra conta')
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
  it('monta um inline_keyboard com callback_data "q:<id>:<índice>" (não o value — cabe em 64 bytes), e SEMPRE inclui o botão de escrever', async () => {
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
    // L4-T18 (item 3, D71): o botão de escrever é SEMPRE incluído, mesmo
    // quando quem chama não pediu — o dono nunca fica com um texto solto sem
    // como responder. O label longo do botão de escrever joga o layout para
    // 1-por-linha (mesma regra de sempre, `buildQuestionKeyboard`) — aqui
    // confere-se cada callback_data, não o agrupamento por linha.
    const botoes = body.reply_markup.inline_keyboard.flat()
    expect(botoes).toEqual([
      { text: '#2563EB', callback_data: 'q:q_abc123:0' },
      { text: '#1E40AF', callback_data: 'q:q_abc123:1' },
      { text: expect.any(String), callback_data: 'q:q_abc123:2' },
    ])
  })

  it('quem já manda o botão de escrever explícito (padrão duvida-dev/retomada-travada): não duplica', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
    ) as unknown as typeof fetch

    await sendTelegramQuestion({
      botToken: BOT,
      chatId: '555',
      questionId: 'q_dup',
      text: 'O que fazer?',
      options: [
        { label: 'Tentar de novo', value: 'tentar' },
        { label: 'Fechar', value: 'fechar' },
        { label: 'Revisar eu mesmo', value: 'revisar' },
        buildFreeTextOption(),
      ],
      fetchImpl,
    })

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse(String(call?.[1]?.body))
    const botoes = body.reply_markup.inline_keyboard.flat()
    expect(botoes).toHaveLength(4)
    expect(
      botoes.filter((b: { callback_data: string }) => b.callback_data.endsWith(':3'))
    ).toHaveLength(1)
  })

  it('recusa pergunta com MAIS de 3 opções fixas', async () => {
    await expect(
      sendTelegramQuestion({
        botToken: BOT,
        chatId: '555',
        questionId: 'q_muitas',
        text: 'Qual?',
        options: [
          { label: 'a', value: 'a' },
          { label: 'b', value: 'b' },
          { label: 'c', value: 'c' },
          { label: 'd', value: 'd' },
        ],
      })
    ).rejects.toThrow(/opç(ões|ões) fixas/i)
  })

  it('recusa pergunta com NENHUMA opção fixa', async () => {
    await expect(
      sendTelegramQuestion({
        botToken: BOT,
        chatId: '555',
        questionId: 'q_vazia',
        text: 'Descreva em texto livre...',
        options: [],
      })
    ).rejects.toThrow(/sem opç/i)
  })

  it('nenhuma opção fixa mesmo com o botão de escrever já incluído: recusa igual', async () => {
    await expect(
      sendTelegramQuestion({
        botToken: BOT,
        chatId: '555',
        questionId: 'q_so_escrever',
        text: 'Descreva em texto livre...',
        options: [buildFreeTextOption()],
      })
    ).rejects.toThrow(/sem opç/i)
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
      options: [{ label: 'Sim', value: 'sim' }],
      fetchImpl,
    })

    expect(messageId).toBe(999)
  })

  it('labels longos: 1 botão por linha (decisão simples de layout), com o botão de escrever na última linha', async () => {
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
    expect(body.reply_markup.inline_keyboard).toHaveLength(3) // 1 por linha + o de escrever
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
      options: [{ label: 'Sim', value: 'sim' }],
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

  // Dois vínculos no mesmo chat deixariam a identidade daquele chat ambígua —
  // e é a identidade do chat que autoriza escrever no repositório de alguém
  // (/desejo). O segundo Start é recusado com a verdade, e nada é escrito.
  it('chat que já é de outra conta não vincula, e o dono lê a verdade', async () => {
    const prisma = fakePrismaChatOcupado('tok_de_outro')

    const reply = await handleTelegramUpdate(prisma as any, {
      update_id: 9,
      message: {
        chat: { id: 555 },
        text: '/start tok_de_outro',
        from: { id: 555, language_code: 'pt-br' },
      },
    })

    expect(prisma.novo.status).toBe('pending')
    expect(prisma.novo.chatId).toBeNull()
    expect(reply?.text).toMatch(/outra conta/i)
    expect(reply?.text).not.toContain(BOT)
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

  it('showAlert manda show_alert:true (pro Telegram mostrar um popup modal, não só o toast)', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    ) as unknown as typeof fetch

    await answerTelegramCallback({
      botToken: BOT,
      callbackQueryId: 'cbq_4',
      text: 'instrução',
      showAlert: true,
      fetchImpl,
    })

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      callback_query_id: 'cbq_4',
      text: 'instrução',
      show_alert: true,
    })
  })
})

describe('collapseTelegramQuestion — a pergunta some com os botões depois de respondida (W3.3.x, feedback do dono)', () => {
  it('reescreve o texto com o que foi escolhido e ZERA o teclado (editMessageText)', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    ) as unknown as typeof fetch

    const ok = await collapseTelegramQuestion({
      botToken: BOT,
      chatId: '555',
      messageId: 42,
      questionText: 'Qual é o azul oficial do site?',
      chosenLabel: '#2563EB',
      fetchImpl,
    })

    expect(ok).toBe(true)
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(call?.[0])).toContain('/editMessageText')
    const body = JSON.parse(String(call?.[1]?.body))
    expect(body.chat_id).toBe('555')
    expect(body.message_id).toBe(42)
    expect(body.text).toBe('Qual é o azul oficial do site?\n\n✓ Você escolheu: #2563EB')
    expect(body.reply_markup).toEqual({ inline_keyboard: [] })
  })

  it('falha do Telegram (ex.: "message is not modified" em edição repetida) não lança — devolve false', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: false }), { status: 400 })
    ) as unknown as typeof fetch
    expect(
      await collapseTelegramQuestion({
        botToken: BOT,
        chatId: '555',
        messageId: 1,
        questionText: 'x',
        chosenLabel: 'y',
        fetchImpl,
      })
    ).toBe(false)
  })

  it('rede fora não derruba a esteira', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    expect(
      await collapseTelegramQuestion({
        botToken: BOT,
        chatId: '555',
        messageId: 1,
        questionText: 'x',
        chosenLabel: 'y',
        fetchImpl,
      })
    ).toBe(false)
  })

  // D70 (02/09): o dono pode responder pelo painel também — quando ele
  // responde por lá primeiro, a mensagem no Telegram precisa dizer isso, NUNCA
  // fingir que foi um clique aqui (a frase "Você escolheu" mentiria sobre quem
  // decidiu). `origem: 'panel'` é a única mudança; sem o parâmetro, o
  // comportamento é IDÊNTICO ao de antes (ver o teste acima, que não passa
  // `origem` e continua esperando "Você escolheu").
  it('origem "panel": a mensagem diz que foi respondida pelo painel, nunca "Você escolheu"', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    ) as unknown as typeof fetch

    const ok = await collapseTelegramQuestion({
      botToken: BOT,
      chatId: '555',
      messageId: 42,
      questionText: 'Qual é o azul oficial do site?',
      chosenLabel: '#2563EB',
      origem: 'panel',
      fetchImpl,
    })

    expect(ok).toBe(true)
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse(String(call?.[1]?.body))
    expect(body.text).toBe('Qual é o azul oficial do site?\n\n✓ Já respondida pelo painel: #2563EB')
    expect(body.reply_markup).toEqual({ inline_keyboard: [] })
  })
})

describe('fecharPerguntaNoTelegramAoResponderPeloPainel — o painel fecha o Telegram quando responde primeiro (D70)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  function fakeDeps(opts: { link?: any; fetchOk?: boolean }) {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: opts.fetchOk ?? true }), {
          status: (opts.fetchOk ?? true) ? 200 : 400,
        })
    ) as unknown as typeof fetch
    const deps = {
      prisma: {
        telegramLink: {
          findUnique: vi.fn(async ({ where }: any) =>
            opts.link && where.userId === opts.link.userId ? opts.link : null
          ),
        },
      },
      botToken: BOT,
      fetchImpl,
    }
    return { deps, fetchImpl }
  }

  const OPCOES = [
    { label: '#2563EB', value: '#2563EB' },
    { label: '#1E40AF', value: '#1E40AF' },
  ]
  const LINK_DONO = { userId: 'user_dono', status: 'linked', chatId: '555' }

  it('sem telegramMessageId (a notificação original nunca chegou a sair) → não faz nada, devolve false', async () => {
    const { deps, fetchImpl } = fakeDeps({ link: LINK_DONO })
    const ok = await fecharPerguntaNoTelegramAoResponderPeloPainel(deps as any, {
      userId: 'user_dono',
      telegramMessageId: null,
      questionText: 'Qual é o azul oficial do site?',
      options: OPCOES,
      resposta: '#2563EB',
    })
    expect(ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sem vínculo do Telegram (ninguém apertou Start) → não faz nada, devolve false', async () => {
    const { deps, fetchImpl } = fakeDeps({ link: undefined })
    const ok = await fecharPerguntaNoTelegramAoResponderPeloPainel(deps as any, {
      userId: 'user_dono',
      telegramMessageId: 42,
      questionText: 'Qual é o azul oficial do site?',
      options: OPCOES,
      resposta: '#2563EB',
    })
    expect(ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('vínculo ainda pending (Start não confirmado) → não faz nada, devolve false', async () => {
    const { deps, fetchImpl } = fakeDeps({
      link: { userId: 'user_dono', status: 'pending', chatId: null },
    })
    const ok = await fecharPerguntaNoTelegramAoResponderPeloPainel(deps as any, {
      userId: 'user_dono',
      telegramMessageId: 42,
      questionText: 'Qual é o azul oficial do site?',
      options: OPCOES,
      resposta: '#2563EB',
    })
    expect(ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('vínculo linked + mensagem existente → edita a mensagem no chat certo, com o rótulo da opção', async () => {
    const { deps, fetchImpl } = fakeDeps({ link: LINK_DONO })
    const ok = await fecharPerguntaNoTelegramAoResponderPeloPainel(deps as any, {
      userId: 'user_dono',
      telegramMessageId: 42,
      questionText: 'Qual é o azul oficial do site?',
      options: OPCOES,
      resposta: '#1E40AF',
    })
    expect(ok).toBe(true)
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(call?.[0])).toContain('/editMessageText')
    const body = JSON.parse(String(call?.[1]?.body))
    expect(body.chat_id).toBe('555')
    expect(body.message_id).toBe(42)
    expect(body.text).toBe('Qual é o azul oficial do site?\n\n✓ Já respondida pelo painel: #1E40AF')
    expect(body.reply_markup).toEqual({ inline_keyboard: [] })
  })

  it('resposta em texto livre (não bate com nenhuma opção) → o rótulo é o próprio texto', async () => {
    const { deps, fetchImpl } = fakeDeps({ link: LINK_DONO })
    await fecharPerguntaNoTelegramAoResponderPeloPainel(deps as any, {
      userId: 'user_dono',
      telegramMessageId: 42,
      questionText: 'Qual é o azul oficial do site?',
      options: OPCOES,
      resposta: 'Usar o roxo da marca nova',
    })
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse(String(call?.[1]?.body))
    expect(body.text).toContain('Usar o roxo da marca nova')
  })

  it('falha do Telegram não lança — best-effort, devolve false', async () => {
    const { deps } = fakeDeps({ link: LINK_DONO, fetchOk: false })
    const ok = await fecharPerguntaNoTelegramAoResponderPeloPainel(deps as any, {
      userId: 'user_dono',
      telegramMessageId: 42,
      questionText: 'x',
      options: [],
      resposta: 'y',
    })
    expect(ok).toBe(false)
  })
})

describe('buildFreeTextOption — a 4ª opção "responda por texto" (feedback do dono: falta escape hatch)', () => {
  it('devolve uma opção com o sentinel FREE_TEXT_OPTION_VALUE', () => {
    const opt = buildFreeTextOption()
    expect(opt.value).toBe(FREE_TEXT_OPTION_VALUE)
    expect(opt.label).toContain('Outro')
  })

  it('aceita label customizado', () => {
    const opt = buildFreeTextOption('✍️ Nenhuma das anteriores')
    expect(opt.label).toBe('✍️ Nenhuma das anteriores')
    expect(opt.value).toBe(FREE_TEXT_OPTION_VALUE)
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
  function fakeDeps(opts: {
    question?: any
    link?: any
    fetchOk?: boolean
    // Por padrão devolve null (comportamento histórico dos testes abaixo, que
    // não olham pro record devolvido). Os testes de colapso passam um record
    // de verdade, como o answer() real devolveria.
    answerReturns?: any
    // L4-T27 (item 3): simula uma falha DE VERDADE do manipulador (ex.:
    // dedupKey corrompido) — `agentQuestionService.answer` real também pode
    // lançar (agent-question.ts `answer()` propaga), e handleTelegramCallback
    // precisa isolar isto sem derrubar quem chamou.
    answerThrows?: Error
  }) {
    const answerCalls: any[] = []
    // L4-T27 (item 3): registra a causa quando o manipulador falha de
    // verdade — nunca console.*, sempre o logger injetado (produção:
    // app.log.error, plugins/telegram.ts).
    const onErrorCalls: string[] = []
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
          if (opts.answerThrows) throw opts.answerThrows
          return opts.answerReturns ?? null
        }),
      },
      botToken: BOT,
      fetchImpl,
      onError: vi.fn((mensagem: string) => onErrorCalls.push(mensagem)),
    }
    return { deps, answerCalls, fetchImpl, onErrorCalls }
  }

  const QUESTION = {
    id: 'q_1',
    userId: 'user_dono',
    text: 'Qual é o azul oficial do site?',
    telegramMessageId: 42,
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

  it('COLAPSA a mensagem depois de responder: edita o texto (com a escolha) e remove o teclado (feedback do dono)', async () => {
    const answeredRecord = { ...QUESTION, status: 'answered', answer: '#1E40AF' }
    const { deps, fetchImpl } = fakeDeps({
      question: QUESTION,
      link: LINK_DONO,
      answerReturns: answeredRecord,
    })

    await handleTelegramCallback(deps as any, {
      update_id: 8,
      callback_query: {
        id: 'cbq_8',
        from: { id: 555 },
        message: { message_id: 42, chat: { id: 555 } },
        data: 'q:q_1:1',
      },
    })

    const editCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('/editMessageText')
    )
    expect(editCall).toBeTruthy()
    const body = JSON.parse(String(editCall?.[1]?.body))
    expect(body.chat_id).toBe('555')
    expect(body.message_id).toBe(42)
    expect(body.text).toBe('Qual é o azul oficial do site?\n\n✓ Você escolheu: #1E40AF')
    expect(body.reply_markup).toEqual({ inline_keyboard: [] })
  })

  it('resposta idempotente (2º clique numa pergunta JÁ respondida): o colapso reflete a resposta ORIGINAL gravada, não o clique novo', async () => {
    // answer() é idempotente por contrato (agent-question.ts): a 2ª chamada
    // devolve o record JÁ existente, com o valor da 1ª resposta — mesmo que o
    // clique atual seja em outra opção. A mensagem editada tem que mostrar a
    // verdade gravada, não o que a pessoa acabou de clicar.
    const originalAnswer = { ...QUESTION, status: 'answered', answer: '#2563EB' }
    const { deps, fetchImpl } = fakeDeps({
      question: QUESTION,
      link: LINK_DONO,
      answerReturns: originalAnswer,
    })

    await handleTelegramCallback(deps as any, {
      update_id: 9,
      callback_query: {
        id: 'cbq_9',
        from: { id: 555 },
        message: { message_id: 42, chat: { id: 555 } },
        data: 'q:q_1:1', // clicou em #1E40AF de novo, mas a resposta gravada é #2563EB
      },
    })

    const editCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('/editMessageText')
    )
    const body = JSON.parse(String(editCall?.[1]?.body))
    expect(body.text).toContain('✓ Você escolheu: #2563EB')
  })

  // FIX-UP L4-T16: o defeito medido — o fechamento no Telegram falhou quando
  // o PAINEL respondeu primeiro (D70, `fecharPerguntaNoTelegramAoResponderPeloPainel`
  // é best-effort), então o botão antigo continuou vivo. O dono clica nele
  // (em OUTRA opção, sem saber que já decidiu pelo painel) e o produto não
  // pode fingir que este clique registrou algo, nem colapsar como se "você"
  // tivesse escolhido aqui — os dois mentiriam sobre quem decidiu.
  //
  // O sinal de "já estava respondida ANTES deste clique" é o `status` da
  // pergunta no `findUnique` INICIAL (antes de chamar `answer()`, que é
  // idempotente e devolveria o mesmo record de qualquer forma).
  it('clique num botão de pergunta JÁ respondida por OUTRO canal (painel): o toast diz a verdade (canal+resposta real), nunca "registrado", e o colapso usa a origem real', async () => {
    const jaRespondidaPeloPainel = {
      ...QUESTION,
      status: 'answered',
      answer: '#2563EB',
      answeredVia: 'panel',
    }
    const { deps, fetchImpl } = fakeDeps({
      question: jaRespondidaPeloPainel, // findUnique inicial já vem 'answered'
      link: LINK_DONO,
      answerReturns: jaRespondidaPeloPainel, // answer() idempotente devolve o mesmo record
    })

    await handleTelegramCallback(deps as any, {
      update_id: 12,
      callback_query: {
        id: 'cbq_12',
        from: { id: 555 },
        message: { message_id: 42, chat: { id: 555 } },
        data: 'q:q_1:1', // clicou em #1E40AF, mas quem decidiu foi o painel, e a resposta é #2563EB
      },
    })

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls
    const alertCall = calls.find((c) => String(c[0]).includes('/answerCallbackQuery'))
    expect(alertCall).toBeTruthy()
    const alertBody = JSON.parse(String(alertCall?.[1]?.body))
    // Nunca finge que este clique registrou a decisão.
    expect(alertBody.text).not.toBe('✓ registrado')
    // Diz por qual canal e qual foi a decisão real.
    expect(alertBody.text).toContain('painel')
    expect(alertBody.text).toContain('#2563EB')
    // NUNCA atribui a opção que a pessoa acabou de clicar agora.
    expect(alertBody.text).not.toContain('#1E40AF')

    const editCall = calls.find((c) => String(c[0]).includes('/editMessageText'))
    expect(editCall).toBeTruthy()
    const editBody = JSON.parse(String(editCall?.[1]?.body))
    // Colapso usa a origem REAL (painel) — nunca "Você escolheu" (D70).
    expect(editBody.text).toContain('✓ Já respondida pelo painel: #2563EB')
    expect(editBody.text).not.toContain('Você escolheu')
  })

  it('sem messageId disponível (nem cq.message, nem telegramMessageId no banco): não tenta colapsar', async () => {
    const questionSemMessageId = { ...QUESTION, telegramMessageId: null }
    const answeredRecord = { ...questionSemMessageId, status: 'answered', answer: '#1E40AF' }
    const { deps, fetchImpl } = fakeDeps({
      question: questionSemMessageId,
      link: LINK_DONO,
      answerReturns: answeredRecord,
    })

    await handleTelegramCallback(deps as any, {
      update_id: 10,
      callback_query: { id: 'cbq_10', from: { id: 555 }, data: 'q:q_1:1' }, // sem cq.message
    })

    const editCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('/editMessageText')
    )
    expect(editCall).toBeUndefined()
  })

  it('4ª opção "Outro" (FREE_TEXT_OPTION_VALUE): NÃO grava resposta nenhuma, só instrui a responder por texto — e NÃO colapsa (a pergunta continua aberta)', async () => {
    const questionComOutro = {
      ...QUESTION,
      options: [
        ...QUESTION.options,
        { label: '✍️ Outro (respondo por texto)', value: FREE_TEXT_OPTION_VALUE },
      ],
    }
    const { deps, answerCalls, fetchImpl } = fakeDeps({
      question: questionComOutro,
      link: LINK_DONO,
    })

    await handleTelegramCallback(deps as any, {
      update_id: 11,
      callback_query: {
        id: 'cbq_11',
        from: { id: 555 },
        message: { message_id: 42, chat: { id: 555 } },
        data: 'q:q_1:2',
      },
    })

    // Nenhuma resposta foi gravada — "Outro" não é uma resposta, é uma instrução.
    expect(answerCalls).toEqual([])

    // Instrui via popup MODAL (show_alert), não o toast discreto de "✓ registrado".
    const alertCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('/answerCallbackQuery')
    )
    expect(alertCall).toBeTruthy()
    const alertBody = JSON.parse(String(alertCall?.[1]?.body))
    expect(alertBody.show_alert).toBe(true)
    expect(alertBody.text).toBeTruthy()

    // A pergunta NÃO colapsa: ainda está esperando a resposta em texto.
    const editCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('/editMessageText')
    )
    expect(editCall).toBeUndefined()
  })

  // ---------------------------------------------------------------------
  // L4-T27 — defeito medido em produção (issue GitOrchAI/gitorch#3866,
  // dedupKey duvida-dev:loureng/patinhas-3d-crafts:3866:a9dad428e18bf927):
  // o dono clicou para responder uma dúvida escalada, a resposta se perdeu
  // (a pergunta continuou `open`, sem canal nem data de resposta) e o
  // teclado nunca colapsou — ele não sabia nem se o produto tinha lido. O
  // ouvinte do bot caiu 5 vezes em 6 horas com a MESMA exceção
  // (`aoResponderDuvidaDoDev: sessão escalada não encontrada...`,
  // retomar-sessao-com-resposta.ts), subindo por handleTelegramCallback.
  // ---------------------------------------------------------------------

  it('ITEM 2: avisoDoManipulador presente (correção/resposta registrada de forma durável, mas a entrega ao dev não foi possível): colapsa mostrando a escolha + um aviso honesto, sem jargão técnico', async () => {
    const answeredComAviso = {
      ...QUESTION,
      status: 'answered',
      answer: '#1E40AF',
      // MESMO texto de AVISO_CORRECAO_SEM_SESSAO_VIVA
      // (retomar-sessao-com-resposta.ts) — fonte única, nunca reinventado
      // aqui.
      avisoDoManipulador:
        'Sua orientação foi guardada e será entregue ao dev quando esta tarefa voltar a ser trabalhada.',
    }
    const { deps, fetchImpl } = fakeDeps({
      question: QUESTION,
      link: LINK_DONO,
      answerReturns: answeredComAviso,
    })

    await handleTelegramCallback(deps as any, {
      update_id: 20,
      callback_query: {
        id: 'cbq_20',
        from: { id: 555 },
        message: { message_id: 42, chat: { id: 555 } },
        data: 'q:q_1:1',
      },
    })

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls

    // O teclado SEMPRE colapsa — inclusive aqui, que antes desta task era
    // exatamente o caso que ficava pendurado (a exceção subia ANTES de
    // chegar neste ponto).
    const editCall = calls.find((c) => String(c[0]).includes('/editMessageText'))
    expect(editCall).toBeTruthy()
    const body = JSON.parse(String(editCall?.[1]?.body))
    expect(body.text).toContain('✓ Você escolheu: #1E40AF')
    expect(body.text).toContain(
      'Sua orientação foi guardada e será entregue ao dev quando esta tarefa voltar a ser trabalhada.'
    )
    // Nada de jargão técnico (sessão/hash/nome de arquivo) no que o dono lê.
    expect(body.text).not.toMatch(/sess[ãa]o|hash|\.ts\b/i)
    expect(body.reply_markup).toEqual({ inline_keyboard: [] })

    // O "carregando" do botão some — não fica girando pra sempre.
    const alertCall = calls.find((c) => String(c[0]).includes('/answerCallbackQuery'))
    expect(alertCall).toBeTruthy()
  })

  it('ITEM 3: answer() lança (falha DE VERDADE do manipulador, ex.: dedupKey corrompido) — NUNCA propaga (o ouvinte do bot segue vivo), loga a causa via onError, tira o "carregando" do botão com um aviso honesto, e NÃO colapsa (a pergunta continua open, o dono pode tentar de novo)', async () => {
    const causaReal = new Error(
      'aoResponderDuvidaDoDev: dedupKey da pergunta tem o prefixo duvida-dev: mas está malformado — a correção do dono não pôde ser interpretada, pergunta continua open'
    )
    const { deps, fetchImpl, onErrorCalls } = fakeDeps({
      question: QUESTION,
      link: LINK_DONO,
      answerThrows: causaReal,
    })

    // A PROVA central do item 3: handleTelegramCallback NUNCA relança — quem
    // chama (o laço do ouvinte, plugins/telegram.ts) nunca vê esta exceção.
    await expect(
      handleTelegramCallback(deps as any, {
        update_id: 21,
        callback_query: {
          id: 'cbq_21',
          from: { id: 555 },
          message: { message_id: 42, chat: { id: 555 } },
          data: 'q:q_1:1',
        },
      })
    ).resolves.toBeUndefined()

    // A causa REAL foi registrada (nunca console.*, nunca engolida em
    // silêncio) — produção passa app.log.error (plugins/telegram.ts).
    expect(onErrorCalls.some((m) => m.includes('dedupKey da pergunta'))).toBe(true)

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls
    const alertCall = calls.find((c) => String(c[0]).includes('/answerCallbackQuery'))
    expect(alertCall).toBeTruthy()
    const alertBody = JSON.parse(String(alertCall?.[1]?.body))
    // Honesto: NUNCA finge sucesso ("✓ registrado") quando não registrou nada.
    expect(alertBody.text).not.toBe('✓ registrado')
    expect(alertBody.text).toMatch(/n[ãa]o deu para registrar/i)

    // A pergunta NÃO foi respondida de verdade — nunca colapsa como se
    // tivesse sido (mentiria sobre o que aconteceu, e tiraria do dono a
    // chance de clicar de novo).
    const editCall = calls.find((c) => String(c[0]).includes('/editMessageText'))
    expect(editCall).toBeUndefined()
  })
})

describe('handleTelegramQuestionReply — resposta em TEXTO LIVRE casada por reply_to_message (feedback do dono: falta escape hatch)', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  function fakeDeps(opts: { question?: any; link?: any; answerReturns?: any }) {
    const answerCalls: any[] = []
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    ) as unknown as typeof fetch
    const deps = {
      prisma: {
        agentQuestion: {
          findFirst: vi.fn(async ({ where }: any) =>
            opts.question &&
            where.userId === opts.question.userId &&
            where.telegramMessageId === opts.question.telegramMessageId
              ? opts.question
              : null
          ),
        },
        telegramLink: {
          findFirst: vi.fn(async ({ where }: any) =>
            opts.link && where.chatId === opts.link.chatId && where.status === 'linked'
              ? opts.link
              : null
          ),
        },
      },
      agentQuestionService: {
        answer: vi.fn(async (id: string, value: string, via: string) => {
          answerCalls.push({ id, value, via })
          return opts.answerReturns ?? null
        }),
      },
      botToken: BOT,
      fetchImpl,
    }
    return { deps, answerCalls, fetchImpl }
  }

  const QUESTION = {
    id: 'q_livre_1',
    userId: 'user_dono',
    text: 'Nenhuma opção serve? Descreva o que você quer.',
    telegramMessageId: 77,
    options: [],
  }
  const LINK_DONO = { userId: 'user_dono', status: 'linked', chatId: '555' }

  it('reply à mensagem da pergunta: casa por reply_to_message.message_id, grava o TEXTO como resposta e colapsa', async () => {
    const answeredRecord = { ...QUESTION, status: 'answered', answer: 'quero um tom mais escuro' }
    const { deps, answerCalls, fetchImpl } = fakeDeps({
      question: QUESTION,
      link: LINK_DONO,
      answerReturns: answeredRecord,
    })

    const handled = await handleTelegramQuestionReply(deps as any, {
      update_id: 1,
      message: {
        chat: { id: 555 },
        text: 'quero um tom mais escuro',
        reply_to_message: { message_id: 77 },
      },
    })

    expect(handled).toBe(true)
    expect(answerCalls).toEqual([
      { id: 'q_livre_1', value: 'quero um tom mais escuro', via: 'telegram' },
    ])

    const editCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes('/editMessageText')
    )
    expect(editCall).toBeTruthy()
    const body = JSON.parse(String(editCall?.[1]?.body))
    expect(body.text).toContain('✓ Você escolheu: quero um tom mais escuro')
    expect(body.reply_markup).toEqual({ inline_keyboard: [] })
  })

  it('mensagem que NÃO é reply a nada: devolve false, não toca no banco nem na rede', async () => {
    const { deps, answerCalls, fetchImpl } = fakeDeps({ question: QUESTION, link: LINK_DONO })

    const handled = await handleTelegramQuestionReply(deps as any, {
      update_id: 2,
      message: { chat: { id: 555 }, text: 'oi, tudo bem?' },
    })

    expect(handled).toBe(false)
    expect(answerCalls).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reply a uma mensagem que NÃO é de nenhuma AgentQuestion: devolve false (segue pro fluxo normal)', async () => {
    const { deps, answerCalls, fetchImpl } = fakeDeps({ question: QUESTION, link: LINK_DONO })

    const handled = await handleTelegramQuestionReply(deps as any, {
      update_id: 3,
      message: {
        chat: { id: 555 },
        text: 'resposta qualquer',
        reply_to_message: { message_id: 999999 }, // não é o 77 da QUESTION
      },
    })

    expect(handled).toBe(false)
    expect(answerCalls).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('GUARD cross-tenant: reply de um chat sem TelegramLink vinculado → ignora', async () => {
    const { deps, answerCalls, fetchImpl } = fakeDeps({ question: QUESTION, link: undefined })

    const handled = await handleTelegramQuestionReply(deps as any, {
      update_id: 4,
      message: {
        chat: { id: 555 },
        text: 'resposta qualquer',
        reply_to_message: { message_id: 77 },
      },
    })

    expect(handled).toBe(false)
    expect(answerCalls).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('texto vazio (reply sem conteúdo, ex.: só uma foto) → devolve false', async () => {
    const { deps, answerCalls } = fakeDeps({ question: QUESTION, link: LINK_DONO })

    const handled = await handleTelegramQuestionReply(deps as any, {
      update_id: 5,
      message: { chat: { id: 555 }, text: '   ', reply_to_message: { message_id: 77 } },
    })

    expect(handled).toBe(false)
    expect(answerCalls).toEqual([])
  })

  it('update sem message (ex.: callback_query) → devolve false', async () => {
    const { deps } = fakeDeps({ question: QUESTION, link: LINK_DONO })
    const handled = await handleTelegramQuestionReply(deps as any, {
      update_id: 6,
      callback_query: { id: 'cbq_x', data: 'q:x:0' },
    })
    expect(handled).toBe(false)
  })
})

// ── D33: o bot entende o apelido do projeto (23/08/2026) ──────────────────
//
// O dono tentou TRÊS vezes registrar um desejo e as três foram recusadas.
// Textos reais, colados do chat dele:
//
//   /desejo quando uma entrega minha falhar na hora de ir para o ar, ...
//   /desejo no patinhas quando uma entrega minha falhar ...
//   /desejo no patinhas-3d-crafts quando uma entrega minha falhar ...
//
// O casador exigia '<projeto>: <pedido>' com DOIS-PONTOS. Sem eles nada casava,
// e 'no patinhas' virava texto comum. A resposta do bot mostrava o formato
// certo, mas ninguém escreve assim — ele bateu na parede três vezes.
//
// A rigidez do DESEMPATE continua certa e o comentário do código explica: nome
// não é único, e sortear mandaria o pedido para o repositório errado. O que
// muda é a ENTRADA.
describe('D33: o apelido do projeto é entendido', () => {
  const dois = [
    { id: 'p1', nome: 'gitorch', repo: 'GitOrchAI/gitorch' },
    { id: 'p2', nome: 'patinhas-3d-crafts', repo: 'loureng/patinhas-3d-crafts' },
  ]

  it('"no patinhas ..." identifica o projeto por parte do nome', () => {
    const r = acharProjeto(dois, 'no patinhas quando uma entrega minha falhar na hora de ir ao ar')
    expect(r?.projeto.repo).toBe('loureng/patinhas-3d-crafts')
    expect(r?.texto).toBe('quando uma entrega minha falhar na hora de ir ao ar')
  })

  it('"no patinhas-3d-crafts ..." também', () => {
    const r = acharProjeto(dois, 'no patinhas-3d-crafts quando uma entrega falhar')
    expect(r?.projeto.repo).toBe('loureng/patinhas-3d-crafts')
    expect(r?.texto).toBe('quando uma entrega falhar')
  })

  it('sem preposição: "patinhas ..." funciona igual', () => {
    const r = acharProjeto(dois, 'patinhas quero um aviso quando quebrar')
    expect(r?.projeto.repo).toBe('loureng/patinhas-3d-crafts')
  })

  it('o formato antigo com dois-pontos CONTINUA valendo', () => {
    const r = acharProjeto(dois, 'loureng/patinhas-3d-crafts: quero um aviso')
    expect(r?.projeto.repo).toBe('loureng/patinhas-3d-crafts')
    expect(r?.texto).toBe('quero um aviso')
  })

  it('sem nenhum projeto no texto, PERGUNTA — nunca sorteia', () => {
    expect(acharProjeto(dois, 'quando uma entrega minha falhar quero um aviso')).toBeNull()
  })

  it('AMBIGUIDADE pergunta em vez de escolher', () => {
    // A guarda central: se o apelido casa com mais de um, o produto não pode
    // adivinhar — o pedido cairia no repositório errado sem ninguém perceber.
    const tres = [...dois, { id: 'p3', nome: 'patinhas-loja', repo: 'loureng/patinhas-loja' }]
    expect(acharProjeto(tres, 'no patinhas quero um aviso')).toBeNull()
  })

  it('o apelido só vale no COMEÇO — citar o projeto no meio da frase não conta', () => {
    // "quero avisar o time do patinhas" não é escolher projeto, é texto do
    // pedido. Casar em qualquer posição roubaria palavras do desejo.
    const r = acharProjeto(dois, 'quero avisar o time do patinhas quando quebrar')
    expect(r).toBeNull()
  })

  it('com UM projeto só, nada muda: o texto inteiro é o pedido', () => {
    const um = [dois[1]!]
    const r = acharProjeto(um, 'no patinhas quero um aviso')
    expect(r?.projeto.repo).toBe('loureng/patinhas-3d-crafts')
    expect(r?.texto).toBe('no patinhas quero um aviso')
  })

  it('apelido sem pedido nenhum não vira desejo vazio', () => {
    expect(acharProjeto(dois, 'patinhas')).toBeNull()
    expect(acharProjeto(dois, 'no patinhas')).toBeNull()
  })
})
