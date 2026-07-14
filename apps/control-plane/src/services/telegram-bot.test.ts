import { describe, expect, it, vi } from 'vitest'
import {
  parseStartToken,
  getTelegramUpdates,
  sendTelegramMessage,
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
    const url = String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(url).toContain('/getUpdates')
    expect(url).toContain('offset=10')
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
    expect(String(call[0])).toContain('/sendMessage')
    expect(JSON.parse(String(call[1].body))).toEqual({ chat_id: '555', text: 'task travada' })
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
