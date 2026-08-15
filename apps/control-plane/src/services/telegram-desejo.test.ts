import { describe, expect, it, vi } from 'vitest'
import {
  interpretarPedidoDeDesejo,
  tratarPedidoDeDesejo,
  type ProjetoParaDesejo,
  type TelegramDesejoDeps,
} from './telegram-bot.js'

describe('interpretarPedidoDeDesejo', () => {
  it('reconhece /desejo e devolve só o texto do pedido', () => {
    const r = interpretarPedidoDeDesejo('/desejo quero avaliação com foto')
    expect(r).toEqual({ ehDesejo: true, texto: 'quero avaliação com foto' })
  })

  it('reconhece /quero como sinônimo', () => {
    expect(interpretarPedidoDeDesejo('/quero busca por cor').ehDesejo).toBe(true)
  })

  it('aceita o comando com o nome do bot colado (grupo)', () => {
    const r = interpretarPedidoDeDesejo('/desejo@GitOrchAI_bot arrumar o carrinho')
    expect(r).toEqual({ ehDesejo: true, texto: 'arrumar o carrinho' })
  })

  it('não reconhece mensagem solta', () => {
    expect(interpretarPedidoDeDesejo('bom dia').ehDesejo).toBe(false)
  })

  it('comando sem texto não vira desejo', () => {
    expect(interpretarPedidoDeDesejo('/desejo   ').ehDesejo).toBe(false)
  })
})

// A porta do desejo no mensageiro. O que está sob teste aqui é a DECISÃO —
// de quem é este chat, para qual repositório vai o pedido, e o que o dono lê de
// volta. A rede (Telegram e GitHub) entra por injeção: nada aqui abre socket.

const PROJETO_UNICO: ProjetoParaDesejo = { id: 'p1', nome: 'Loja', repo: 'dono/loja' }

// `language_code` vai junto porque a resposta é no idioma de quem fala com o
// bot (mesmo `pickLocale` do /start) — sem ele, o esperado seria o texto em
// inglês.
function updateComTexto(texto: string, chatId: number | string = 555) {
  return {
    update_id: 1,
    message: { chat: { id: chatId }, text: texto, from: { language_code: 'pt-BR' } },
  }
}

function deps(over: Partial<TelegramDesejoDeps> = {}): TelegramDesejoDeps {
  return {
    donoDoChat: vi.fn().mockResolvedValue('user_a'),
    projetosDoDono: vi.fn().mockResolvedValue([PROJETO_UNICO]),
    criarIssue: vi.fn().mockResolvedValue({ numero: 77 }),
    ...over,
  }
}

describe('tratarPedidoDeDesejo', () => {
  it('mensagem que não é desejo não é assunto nosso e não toca no GitHub', async () => {
    const d = deps()
    const r = await tratarPedidoDeDesejo(d, updateComTexto('bom dia'))
    expect(r).toBeNull()
    expect(d.criarIssue).not.toHaveBeenCalled()
  })

  it('chat sem vínculo recebe a instrução de vincular, sem criar issue', async () => {
    const d = deps({ donoDoChat: vi.fn().mockResolvedValue(null) })
    const r = await tratarPedidoDeDesejo(d, updateComTexto('/desejo quero busca por cor'))
    expect(r?.chatId).toBe('555')
    expect(r?.text).toMatch(/conectar|vincul/i)
    expect(d.criarIssue).not.toHaveBeenCalled()
  })

  it('dono sem projeto nenhum é avisado, sem criar issue', async () => {
    const d = deps({ projetosDoDono: vi.fn().mockResolvedValue([]) })
    const r = await tratarPedidoDeDesejo(d, updateComTexto('/desejo quero busca por cor'))
    expect(r?.text).toMatch(/projeto/i)
    expect(d.criarIssue).not.toHaveBeenCalled()
  })

  it('com um único projeto, cria a issue com a etiqueta e devolve número e endereço', async () => {
    const d = deps()
    const r = await tratarPedidoDeDesejo(d, updateComTexto('/desejo quero avaliação com foto'))
    expect(d.criarIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'dono/loja',
        titulo: 'quero avaliação com foto',
        etiquetas: ['wishlist'],
      })
    )
    expect(r?.text).toContain('77')
    expect(r?.text).toContain('https://github.com/dono/loja/issues/77')
  })

  it('com mais de um projeto e sem escolha, pede o projeto listando os nomes', async () => {
    const d = deps({
      projetosDoDono: vi
        .fn()
        .mockResolvedValue([PROJETO_UNICO, { id: 'p2', nome: 'Site', repo: 'dono/site' }]),
    })
    const r = await tratarPedidoDeDesejo(d, updateComTexto('/desejo quero busca por cor'))
    expect(r?.text).toContain('Loja')
    expect(r?.text).toContain('Site')
    expect(d.criarIssue).not.toHaveBeenCalled()
  })

  it('com mais de um projeto, o nome antes dos dois-pontos escolhe o repositório', async () => {
    const d = deps({
      projetosDoDono: vi
        .fn()
        .mockResolvedValue([PROJETO_UNICO, { id: 'p2', nome: 'Site', repo: 'dono/site' }]),
    })
    await tratarPedidoDeDesejo(d, updateComTexto('/desejo Site: quero busca por cor'))
    expect(d.criarIssue).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'dono/site', titulo: 'quero busca por cor' })
    )
  })

  it('GitHub recusando não vaza detalhe interno para o chat', async () => {
    const registrarFalha = vi.fn()
    const d = deps({
      criarIssue: vi.fn().mockRejectedValue(new Error('token ghp_segredo inválido')),
      registrarFalha,
    })
    const r = await tratarPedidoDeDesejo(d, updateComTexto('/desejo quero busca por cor'))
    expect(r?.text).not.toContain('ghp_')
    expect(r?.text).toMatch(/não consegui|nao consegui/i)
    expect(registrarFalha).toHaveBeenCalled()
  })
})
