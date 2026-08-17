import { describe, expect, it, beforeEach } from 'vitest'
import {
  startTelegramLink,
  readTelegramLink,
  bindChatFromStart,
  resolveNotifyChatId,
  resolveDonoDoChat,
  LINK_TOKEN_TTL_MS,
} from './telegram-link.js'

// O passo 8 do wizard prometia aviso no Telegram e guardava um @username. A API
// do Telegram não manda mensagem para @username de pessoa — ela exige `chat_id`,
// que só nasce quando a pessoa aperta Start no bot. Estes testes cobrem o
// caminho que TORNA a promessa verdadeira (deep link com token -> /start ->
// chat_id vinculado ao dono) e, principalmente, PARA QUEM a mensagem vai.

/* eslint-disable @typescript-eslint/no-explicit-any */
// Filtro do fake, com o mesmo contrato do `where` do Prisma que os serviços
// usam (incluindo `NOT`, que é como se pergunta "existe OUTRA conta neste
// chat?").
function casa(row: any, where: any): boolean {
  if (where.token !== undefined && row.token !== where.token) return false
  if (where.userId !== undefined && row.userId !== where.userId) return false
  if (where.status !== undefined && row.status !== where.status) return false
  if (where.chatId !== undefined && row.chatId !== where.chatId) return false
  if (where.NOT?.userId !== undefined && row.userId === where.NOT.userId) return false
  return true
}

// Fake do Prisma para telegram_links: store em memória com os métodos que o
// serviço usa. Mesmo padrão de environment.test.ts / engine-connection.test.ts.
function fakePrisma() {
  const store = new Map<string, any>()
  let seq = 0
  const rows = () => [...store.values()]
  return {
    store,
    telegramLink: {
      findUnique: async ({ where }: any) =>
        rows().find((r) => (where.userId ? r.userId === where.userId : r.token === where.token)) ??
        null,
      findFirst: async ({ where }: any) => rows().find((r) => casa(r, where)) ?? null,
      findMany: async ({ where }: any = {}) => rows().filter((r) => casa(r, where ?? {})),
      upsert: async ({ where, create, update }: any) => {
        const existing = rows().find((r) => r.userId === where.userId)
        if (existing) {
          const merged = { ...existing, ...update }
          store.set(existing.id, merged)
          return merged
        }
        const rec = {
          id: `tgl_${++seq}`,
          status: 'pending',
          token: null,
          tokenExpiresAt: null,
          chatId: null,
          linkedAt: null,
          createdAt: new Date(),
          ...create,
        }
        store.set(rec.id, rec)
        return rec
      },
      // Escrita CONDICIONAL (mesmo contrato do updateMany do Prisma): só casa as
      // linhas do `where`. É o que garante o uso único do token sob corrida.
      updateMany: async ({ where, data }: any) => {
        const matched = rows().filter((r) => {
          if (where.token !== undefined && r.token !== where.token) return false
          if (where.status !== undefined && r.status !== where.status) return false
          if (where.tokenExpiresAt?.gt !== undefined) {
            if (!r.tokenExpiresAt || !(r.tokenExpiresAt > where.tokenExpiresAt.gt)) return false
          }
          return true
        })
        for (const row of matched) store.set(row.id, { ...row, ...data })
        return { count: matched.length }
      },
    },
  }
}

const NOW = new Date('2026-07-14T12:00:00Z')

describe('vínculo do Telegram: token -> chat_id', () => {
  let prisma: ReturnType<typeof fakePrisma>

  beforeEach(() => {
    prisma = fakePrisma()
  })

  it('gera o deep link REAL do bot com um token (é ele que traz o chat_id de volta)', async () => {
    const view = await startTelegramLink(prisma as any, 'user_a', { now: NOW })

    expect(view.status).toBe('pending')
    // t.me/<bot>?start=<token> — o parâmetro `start` é o que o Telegram devolve
    // para o bot na mensagem `/start <token>`.
    expect(view.deepLink).toMatch(/^https:\/\/t\.me\/[A-Za-z0-9_]+\?start=[A-Za-z0-9_-]{20,64}$/)
  })

  it('reabrir o passo NÃO rotaciona o token válido (o link que o cliente já abriu continua valendo)', async () => {
    const first = await startTelegramLink(prisma as any, 'user_a', { now: NOW })
    const again = await startTelegramLink(prisma as any, 'user_a', { now: NOW })
    expect(again.deepLink).toBe(first.deepLink)
  })

  it('token vencido vira um token NOVO (link velho não ressuscita)', async () => {
    const first = await startTelegramLink(prisma as any, 'user_a', { now: NOW })
    const later = new Date(NOW.getTime() + LINK_TOKEN_TTL_MS + 1000)
    const renewed = await startTelegramLink(prisma as any, 'user_a', { now: later })
    expect(renewed.deepLink).not.toBe(first.deepLink)
    expect(renewed.status).toBe('pending')
  })

  it('o Start do cliente vincula o chat_id ao DONO do token', async () => {
    const view = await startTelegramLink(prisma as any, 'user_a', { now: NOW })
    const token = new URL(view.deepLink as string).searchParams.get('start') as string

    const result = await bindChatFromStart(prisma as any, { token, chatId: '555', now: NOW })

    expect(result).toEqual({ ok: true, userId: 'user_a' })
    const status = await readTelegramLink(prisma as any, 'user_a', { now: NOW })
    expect(status.status).toBe('linked')
    // Vinculado não expõe mais deep link: não há o que apertar.
    expect(status.deepLink).toBeNull()
  })

  it('token é de USO ÚNICO: repetir o /start não revincula (link vazado não rouba o chat do dono)', async () => {
    const view = await startTelegramLink(prisma as any, 'user_a', { now: NOW })
    const token = new URL(view.deepLink as string).searchParams.get('start') as string
    await bindChatFromStart(prisma as any, { token, chatId: '555', now: NOW })

    // O invasor tenta o MESMO token para apontar o aviso pro chat dele.
    const replay = await bindChatFromStart(prisma as any, { token, chatId: '999', now: NOW })

    expect(replay).toEqual({ ok: false, reason: 'unknown_token' })
    expect(await resolveNotifyChatId(prisma as any, { userId: 'user_a' })).toBe('555')
  })

  it('token vencido NÃO vincula (e diz por quê, sem fingir sucesso)', async () => {
    const view = await startTelegramLink(prisma as any, 'user_a', { now: NOW })
    const token = new URL(view.deepLink as string).searchParams.get('start') as string
    const tarde = new Date(NOW.getTime() + LINK_TOKEN_TTL_MS + 1000)

    expect(await bindChatFromStart(prisma as any, { token, chatId: '555', now: tarde })).toEqual({
      ok: false,
      reason: 'expired',
    })
    expect(await resolveNotifyChatId(prisma as any, { userId: 'user_a' })).toBeNull()
  })

  it('token que nunca existiu não vincula nada', async () => {
    expect(
      await bindChatFromStart(prisma as any, { token: 'inventado', chatId: '555', now: NOW })
    ).toEqual({ ok: false, reason: 'unknown_token' })
  })

  it('sem vínculo nenhum, o estado é "unlinked" — nunca um ✓ inventado', async () => {
    expect(await readTelegramLink(prisma as any, 'user_a', { now: NOW })).toEqual({
      status: 'unlinked',
      deepLink: null,
    })
  })

  it('pendente vencido volta a "unlinked" (a UI oferece conectar de novo, não mente "aguardando")', async () => {
    await startTelegramLink(prisma as any, 'user_a', { now: NOW })
    const tarde = new Date(NOW.getTime() + LINK_TOKEN_TTL_MS + 1000)
    expect((await readTelegramLink(prisma as any, 'user_a', { now: tarde })).status).toBe(
      'unlinked'
    )
  })
})

// O caminho inverso do aviso: dado um chat, DE QUEM ele é. É esta resposta que
// autoriza escrever no repositório de alguém (o /desejo do mensageiro), então
// ela não pode ser "uma linha qualquer": `chat_id` não é único no banco.
describe('de quem é este chat (a identidade que autoriza escrever no repositório)', () => {
  let prisma: ReturnType<typeof fakePrisma>

  const link = async (userId: string, chatId: string) => {
    const view = await startTelegramLink(prisma as any, userId, { now: NOW })
    const token = new URL(view.deepLink as string).searchParams.get('start') as string
    return bindChatFromStart(prisma as any, { token, chatId, now: NOW })
  }

  beforeEach(() => {
    prisma = fakePrisma()
  })

  it('um vínculo só: o chat é daquele dono', async () => {
    await link('user_a', '555')
    expect(await resolveDonoDoChat(prisma as any, '555')).toEqual({
      tipo: 'unico',
      userId: 'user_a',
    })
  })

  it('chat que ninguém vinculou não é de ninguém', async () => {
    expect(await resolveDonoDoChat(prisma as any, '555')).toEqual({ tipo: 'nenhum' })
  })

  it('dois vínculos no MESMO chat: ambíguo — ninguém é escolhido no escuro', async () => {
    await link('user_a', '555')
    // Linha gravada direto no store: simula a duplicata que o banco AINDA
    // aceita (chat_id não é único) — vinda de uma instalação antiga ou de duas
    // vinculações concorrentes. O sistema tem que RECUSAR, não sortear.
    prisma.store.set('legado', {
      id: 'legado',
      userId: 'user_b',
      status: 'linked',
      token: null,
      tokenExpiresAt: null,
      chatId: '555',
      linkedAt: NOW,
    })
    expect(await resolveDonoDoChat(prisma as any, '555')).toEqual({ tipo: 'ambiguo' })
  })

  it('um chat já conectado a outra conta NÃO é tomado por um segundo Start', async () => {
    await link('user_a', '555')
    expect(await link('user_b', '555')).toEqual({ ok: false, reason: 'chat_taken' })
    // E o chat continua sendo de quem era: nada de identidade oscilando.
    expect(await resolveDonoDoChat(prisma as any, '555')).toEqual({
      tipo: 'unico',
      userId: 'user_a',
    })
    expect(await resolveNotifyChatId(prisma as any, { userId: 'user_b' })).toBeNull()
  })

  it('a MESMA conta pode revincular o próprio chat (não é chat de outro)', async () => {
    await link('user_a', '555')
    // A conta reabre o passo do wizard (o vínculo dela volta a pendente) e
    // aperta Start no MESMO chat: a guarda é contra chat de OUTRA conta, nunca
    // contra a própria.
    const atual = [...prisma.store.values()].find((r: any) => r.userId === 'user_a')
    prisma.store.set(atual.id, { ...atual, status: 'pending', chatId: null })
    expect(await link('user_a', '555')).toEqual({ ok: true, userId: 'user_a' })
  })
})

describe('para QUEM o aviso vai (o notificador escolhendo o chat)', () => {
  let prisma: ReturnType<typeof fakePrisma>

  // Vincula um chat a um usuário pelo caminho real (token -> /start).
  const link = async (userId: string, chatId: string) => {
    const view = await startTelegramLink(prisma as any, userId, { now: NOW })
    const token = new URL(view.deepLink as string).searchParams.get('start') as string
    await bindChatFromStart(prisma as any, { token, chatId, now: NOW })
  }

  beforeEach(async () => {
    prisma = fakePrisma()
    await link('cliente_a', '111')
    await link('cliente_b', '222')
  })

  it('o evento do projeto do cliente A vai para o chat de A', async () => {
    expect(await resolveNotifyChatId(prisma as any, { userId: 'cliente_a' })).toBe('111')
  })

  it('ISOLAMENTO: o cliente A jamais recebe o evento do cliente B', async () => {
    const paraA = await resolveNotifyChatId(prisma as any, { userId: 'cliente_a' })
    const paraB = await resolveNotifyChatId(prisma as any, { userId: 'cliente_b' })
    expect(paraA).toBe('111')
    expect(paraB).toBe('222')
    expect(paraA).not.toBe(paraB)
  })

  it('cliente SEM vínculo não vira mensagem no chat da gitorch (o repo/issue dele não é nosso assunto)', async () => {
    const chat = await resolveNotifyChatId(
      prisma as any,
      { userId: 'cliente_c', user: { email: 'cliente-c@example.test' } },
      { instanceOwnerEmail: 'dono@gitorch.test', instanceChatId: '-100gitorch' }
    )
    expect(chat).toBeNull()
  })

  it('projeto NOSSO (dono da instância) sem vínculo cai no nosso chat — aí sim é notificação interna', async () => {
    const chat = await resolveNotifyChatId(
      prisma as any,
      { userId: 'dono_instancia', user: { email: 'Dono@GitOrch.test' } },
      { instanceOwnerEmail: 'dono@gitorch.test', instanceChatId: '-100gitorch' }
    )
    expect(chat).toBe('-100gitorch')
  })

  it('projeto NOSSO COM vínculo: o vínculo vence (o dono recebe no próprio chat)', async () => {
    await link('dono_instancia', '777')
    const chat = await resolveNotifyChatId(
      prisma as any,
      { userId: 'dono_instancia', user: { email: 'dono@gitorch.test' } },
      { instanceOwnerEmail: 'dono@gitorch.test', instanceChatId: '-100gitorch' }
    )
    expect(chat).toBe('777')
  })

  it('projeto legado sem dono não notifica ninguém (não há a quem avisar)', async () => {
    const chat = await resolveNotifyChatId(
      prisma as any,
      { userId: null },
      { instanceOwnerEmail: 'dono@gitorch.test', instanceChatId: '-100gitorch' }
    )
    expect(chat).toBeNull()
  })

  it('vínculo ainda pendente (não apertou Start) não tem chat: não notifica', async () => {
    await startTelegramLink(prisma as any, 'cliente_d', { now: NOW })
    expect(await resolveNotifyChatId(prisma as any, { userId: 'cliente_d' })).toBeNull()
  })
})
