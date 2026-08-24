import { describe, expect, it, vi } from 'vitest'
import {
  tratarPedidoDeDesejo,
  tratarCliqueDeProjeto,
  type ProjetoParaDesejo,
  type TelegramDesejoDeps,
  type TelegramUpdate,
} from './telegram-bot.js'
import { PRAZO_DO_PENDENTE_MS, type PendenteGuardado } from './desejo-pendente.js'

const GITORCH: ProjetoParaDesejo = { id: 'p1', nome: 'gitorch', repo: 'GitOrchAI/gitorch' }
const PATINHAS: ProjetoParaDesejo = {
  id: 'p2',
  nome: 'patinhas-3d-crafts',
  repo: 'loureng/patinhas-3d-crafts',
}
const CHAT = 6725599649
const AGORA = new Date('2026-08-24T12:00:00Z')

function pendenteGuardado(over: Partial<PendenteGuardado> = {}): PendenteGuardado {
  return {
    id: 'pnd_1',
    userId: 'user_a',
    chatId: String(CHAT),
    texto: 'quero que o site aceite avaliação com foto',
    usadoEm: null,
    createdAt: new Date(AGORA.getTime() - 60_000),
    ...over,
  }
}

function deps(over: Partial<TelegramDesejoDeps> = {}): TelegramDesejoDeps {
  return {
    donoDoChat: vi.fn().mockResolvedValue({ tipo: 'unico', userId: 'user_a' }),
    projetosDoDono: vi.fn().mockResolvedValue([GITORCH, PATINHAS]),
    confirmarAcesso: vi.fn().mockResolvedValue(true),
    criarIssue: vi.fn().mockResolvedValue({ numero: 4242 }),
    guardarPendente: vi.fn().mockResolvedValue({ id: 'pnd_1' }),
    lerPendente: vi.fn().mockResolvedValue(pendenteGuardado()),
    marcarPendenteUsado: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

function mensagem(texto: string): TelegramUpdate {
  return {
    message: { chat: { id: CHAT }, from: { id: CHAT, language_code: 'pt-BR' }, text: texto },
  } as TelegramUpdate
}

function clique(data: string, chatId: number = CHAT): TelegramUpdate {
  return {
    callback_query: {
      id: 'cb_1',
      from: { id: chatId, language_code: 'pt-BR' },
      message: { message_id: 9, chat: { id: chatId } },
      data,
    },
  } as TelegramUpdate
}

function teclado(r: unknown): { text: string; callback_data: string }[][] {
  const t = (r as { teclado?: { inline_keyboard?: unknown } }).teclado
  return (t?.inline_keyboard ?? []) as { text: string; callback_data: string }[][]
}

describe('a pergunta vira BOTÃO', () => {
  // O pedido do dono, textualmente: "a pessoa manda o /desejo <pedido> e o
  // gitorch retorna falando pra qual quer, então ele coloca com OPÇÕES de
  // botão 1, 2, 3".
  it('quem tem dois projetos e não disse qual recebe um botão por projeto', async () => {
    const d = deps()
    const r = await tratarPedidoDeDesejo(d, mensagem('/desejo trocar a cor do botão de comprar'))
    const linhas = teclado(r)
    expect(linhas).toHaveLength(2)
    expect(linhas[0]?.[0]?.text).toContain('GitOrchAI/gitorch')
    expect(linhas[1]?.[0]?.text).toContain('loureng/patinhas-3d-crafts')
    expect(r?.text).not.toMatch(/Diga qual/i)
  })

  it('o pedido inteiro é guardado antes de perguntar — é ele que o clique registra', async () => {
    const d = deps()
    await tratarPedidoDeDesejo(d, mensagem('/desejo trocar a cor do botão de comprar'))
    expect(d.guardarPendente).toHaveBeenCalledWith({
      userId: 'user_a',
      chatId: String(CHAT),
      texto: 'trocar a cor do botão de comprar',
    })
  })

  it('quem escreveu o apelido não é perguntado: o botão só aparece na dúvida', async () => {
    const d = deps()
    const r = await tratarPedidoDeDesejo(d, mensagem('/desejo no patinhas trocar a cor'))
    expect(teclado(r)).toHaveLength(0)
    expect(d.criarIssue).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'loureng/patinhas-3d-crafts' })
    )
  })

  // Falhar ao guardar não pode ENGOLIR o pedido: sem botão, o dono ainda tem o
  // caminho de texto, que funciona — só dá mais trabalho.
  it('banco fora do ar cai no texto de sempre, nunca no silêncio', async () => {
    const d = deps({ guardarPendente: vi.fn().mockRejectedValue(new Error('sem banco')) })
    const r = await tratarPedidoDeDesejo(d, mensagem('/desejo trocar a cor'))
    expect(teclado(r)).toHaveLength(0)
    expect(r?.text).toMatch(/Diga qual/i)
  })
})

describe('o toque no botão registra o pedido', () => {
  it('toca no patinhas e a issue nasce no patinhas, com o texto original', async () => {
    const d = deps()
    const r = await tratarCliqueDeProjeto(d, clique('desejo:pnd_1:1'), AGORA)
    expect(d.criarIssue).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'loureng/patinhas-3d-crafts' })
    )
    const corpo = (d.criarIssue as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.corpo as string
    expect(corpo).toContain('quero que o site aceite avaliação com foto')
    expect(r?.text).toContain('4242')
    expect(r?.callbackQueryId).toBe('cb_1')
  })

  // O clique do PO viaja no MESMO canal. Roubá-lo deixaria o dono sem resposta
  // dos dois lados de uma vez.
  it('não rouba o clique da dúvida do PO', async () => {
    const d = deps()
    expect(await tratarCliqueDeProjeto(d, clique('q:abc:1'), AGORA)).toBeNull()
    expect(d.lerPendente).not.toHaveBeenCalled()
  })

  it('o MESMO clique reentregue não abre a segunda issue', async () => {
    const d = deps({
      lerPendente: vi.fn().mockResolvedValue(pendenteGuardado({ usadoEm: new Date() })),
    })
    const r = await tratarCliqueDeProjeto(d, clique('desejo:pnd_1:0'), AGORA)
    expect(d.criarIssue).not.toHaveBeenCalled()
    expect(r?.text).toBe('')
  })

  it('carimba o pendente ANTES de chamar o GitHub', async () => {
    const ordem: string[] = []
    const d = deps({
      marcarPendenteUsado: vi.fn().mockImplementation(async () => {
        ordem.push('carimbo')
      }),
      criarIssue: vi.fn().mockImplementation(async () => {
        ordem.push('github')
        return { numero: 1 }
      }),
    })
    await tratarCliqueDeProjeto(d, clique('desejo:pnd_1:0'), AGORA)
    expect(ordem).toEqual(['carimbo', 'github'])
  })

  it('carimbo que falha não deixa a issue nascer', async () => {
    const d = deps({
      marcarPendenteUsado: vi.fn().mockRejectedValue(new Error('já usado')),
    })
    const r = await tratarCliqueDeProjeto(d, clique('desejo:pnd_1:0'), AGORA)
    expect(d.criarIssue).not.toHaveBeenCalled()
    expect(r?.text).toMatch(/não consegui/i)
  })

  it('pedido de mais de um dia não vira tarefa', async () => {
    const d = deps({
      lerPendente: vi
        .fn()
        .mockResolvedValue(
          pendenteGuardado({ createdAt: new Date(AGORA.getTime() - PRAZO_DO_PENDENTE_MS - 1) })
        ),
    })
    const r = await tratarCliqueDeProjeto(d, clique('desejo:pnd_1:0'), AGORA)
    expect(d.criarIssue).not.toHaveBeenCalled()
    expect(r?.text).toMatch(/mais de um dia/i)
  })

  it('pendente que sumiu recebe recado próprio, não "venceu"', async () => {
    const d = deps({ lerPendente: vi.fn().mockResolvedValue(null) })
    const r = await tratarCliqueDeProjeto(d, clique('desejo:sumiu:0'), AGORA)
    expect(r?.text).toMatch(/não achei mais/i)
  })

  // O botão não pode virar a porta por onde um pedido alheio nasce no
  // repositório errado.
  it('clique de OUTRA conversa com id de pendente alheio não registra nada', async () => {
    const d = deps()
    const r = await tratarCliqueDeProjeto(d, clique('desejo:pnd_1:1', 999888), AGORA)
    expect(d.criarIssue).not.toHaveBeenCalled()
    expect(r?.text).toMatch(/não achei mais/i)
  })

  it('pendente de outro dono não vira issue neste chat', async () => {
    const d = deps({
      lerPendente: vi.fn().mockResolvedValue(pendenteGuardado({ userId: 'outro_dono' })),
    })
    const r = await tratarCliqueDeProjeto(d, clique('desejo:pnd_1:1'), AGORA)
    expect(d.criarIssue).not.toHaveBeenCalled()
    expect(r?.text).toMatch(/não achei mais/i)
  })

  // Entre a pergunta e o toque o projeto pode ter saído do ar. O de baixo na
  // lista NÃO é "o mais parecido" — é outro repositório.
  it('índice fora da lista de agora não escorrega para o projeto vizinho', async () => {
    const d = deps({ projetosDoDono: vi.fn().mockResolvedValue([GITORCH]) })
    const r = await tratarCliqueDeProjeto(d, clique('desejo:pnd_1:1'), AGORA)
    expect(d.criarIssue).not.toHaveBeenCalled()
    expect(r?.text).toMatch(/Diga qual/i)
  })

  it('acesso perdido ao repositório barra o clique', async () => {
    const d = deps({ confirmarAcesso: vi.fn().mockResolvedValue(false) })
    const r = await tratarCliqueDeProjeto(d, clique('desejo:pnd_1:1'), AGORA)
    expect(d.criarIssue).not.toHaveBeenCalled()
    expect(r?.text).toMatch(/não tem mais acesso/i)
  })
})
