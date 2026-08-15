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

  // O comando precisa TERMINAR ali (espaço, nome do bot ou fim da linha). Sem
  // isso, um erro de digitação vira pedido: "/desejos" viraria o pedido "s" — e
  // como a esteira consome a wishlist ABERTA MAIS RECENTE, esse lixo passaria
  // na frente do pedido de verdade.
  it('comando parecido não é o comando (/desejos não é /desejo)', () => {
    expect(interpretarPedidoDeDesejo('/desejos')).toEqual({ ehDesejo: false, texto: '' })
  })

  it('palavra colada no comando não vira o texto do pedido', () => {
    expect(interpretarPedidoDeDesejo('/quero-relatorio')).toEqual({ ehDesejo: false, texto: '' })
  })

  it('comando com o nome do bot e sem texto também não vira desejo', () => {
    expect(interpretarPedidoDeDesejo('/desejo@GitOrchAI_bot').ehDesejo).toBe(false)
  })
})

// A porta do desejo no mensageiro. O que está sob teste aqui é a DECISÃO —
// de quem é este chat, para qual repositório vai o pedido, e o que o dono lê de
// volta. A rede (Telegram e GitHub) entra por injeção: nada aqui abre socket.

const PROJETO_UNICO: ProjetoParaDesejo = { id: 'p1', nome: 'Loja', repo: 'dono/loja' }

// `language_code` vai junto porque a resposta é no idioma de quem fala com o
// bot (mesmo `pickLocale` do /start) — sem ele, o esperado seria o texto em
// inglês. `from.id` é QUEM DIGITOU: no chat privado ele é igual ao id do chat,
// e é essa igualdade que prova que a pessoa é a dona do vínculo.
// `null` em `remetenteId` = update SEM quem digitou (canal, ou mensagem
// anônima): o bot não tem como saber de quem é o pedido.
function updateComTexto(
  texto: string,
  chatId: number | string = 555,
  remetenteId: number | string | null = chatId
) {
  return {
    update_id: 1,
    message: {
      chat: { id: chatId },
      text: texto,
      from: { language_code: 'pt-BR', ...(remetenteId === null ? {} : { id: remetenteId }) },
    },
  }
}

function deps(over: Partial<TelegramDesejoDeps> = {}): TelegramDesejoDeps {
  return {
    donoDoChat: vi.fn().mockResolvedValue({ tipo: 'unico', userId: 'user_a' }),
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

  // O pedido vira issue no repositório do dono e a esteira o executa sozinha.
  // Então quem manda é a PESSOA que digitou, nunca o chat: num grupo (o vínculo
  // aceita `/start@Bot <token>`), qualquer participante escreveria no
  // repositório alheio. Só há uma pessoa que sabemos ser a dona: aquela cujo
  // chat PRIVADO é o vínculo — no privado, `from.id` é o próprio `chat.id`.
  it('em grupo, quem digita não é provadamente o dono: nada é escrito no repositório', async () => {
    const d = deps()
    const r = await tratarPedidoDeDesejo(
      d,
      updateComTexto('/desejo trocar o checkout inteiro', -100777, 999)
    )
    expect(d.criarIssue).not.toHaveBeenCalled()
    expect(r?.chatId).toBe('-100777')
    expect(r?.text).toMatch(/privado/i)
  })

  it('mensagem sem remetente identificável não vira pedido', async () => {
    const d = deps()
    const r = await tratarPedidoDeDesejo(
      d,
      updateComTexto('/desejo quero busca por cor', 555, null)
    )
    expect(d.criarIssue).not.toHaveBeenCalled()
    expect(r?.text).toMatch(/privado/i)
  })

  it('chat conectado a mais de uma conta não escolhe repositório no escuro', async () => {
    const d = deps({ donoDoChat: vi.fn().mockResolvedValue({ tipo: 'ambiguo' }) })
    const r = await tratarPedidoDeDesejo(d, updateComTexto('/desejo quero busca por cor'))
    expect(d.criarIssue).not.toHaveBeenCalled()
    expect(r?.text).toMatch(/mais de uma conta/i)
  })

  it('chat sem vínculo recebe a instrução de vincular, sem criar issue', async () => {
    const d = deps({ donoDoChat: vi.fn().mockResolvedValue({ tipo: 'nenhum' }) })
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
