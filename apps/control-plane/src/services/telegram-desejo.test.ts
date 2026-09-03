import { describe, expect, it, vi } from 'vitest'
import {
  ehPedidoDeDesejoSemTexto,
  interpretarPedidoDeDesejo,
  tratarPedidoDeDesejo,
  type ProjetoParaDesejo,
  type TelegramDesejoDeps,
} from './telegram-bot.js'
import {
  AcessoNaoVerificavelError,
  CredencialDoGithubInvalidaError,
} from './acesso-ao-repositorio.js'

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

  // Convenção do Telegram: num grupo com vários bots, o comando endereçado a
  // OUTRO bot é dele, não nosso. Atender assim mesmo faria dois bots
  // responderem ao mesmo comando — e, pior aqui, escreveria uma issue no
  // repositório do dono a partir de uma ordem que não era para nós.
  it('comando endereçado a outro bot não é nosso', () => {
    expect(interpretarPedidoDeDesejo('/quero@OutroBot cafe')).toEqual({
      ehDesejo: false,
      texto: '',
    })
  })

  it('o nome do bot não diferencia maiúscula de minúscula (o Telegram também não)', () => {
    expect(interpretarPedidoDeDesejo('/desejo@gitorchai_bot busca por cor').ehDesejo).toBe(true)
  })

  it('respeita o nome de bot informado, não só o do ambiente', () => {
    expect(interpretarPedidoDeDesejo('/desejo@meu_bot cafe', 'meu_bot').ehDesejo).toBe(true)
    expect(interpretarPedidoDeDesejo('/desejo@GitOrchAI_bot cafe', 'meu_bot').ehDesejo).toBe(false)
  })
})

// "Não é o nosso comando" e "é o nosso comando, e a pessoa não escreveu o
// pedido" são fatos DIFERENTES, e só o segundo merece resposta. Enquanto os
// dois caíam no mesmo silêncio, quem digitava "/desejo" para descobrir como o
// comando funciona não recebia nem exemplo nem erro.
describe('ehPedidoDeDesejoSemTexto', () => {
  it('reconhece o comando nosso sem pedido escrito', () => {
    expect(ehPedidoDeDesejoSemTexto('/desejo', 'GitOrchAI_bot')).toBe(true)
    expect(ehPedidoDeDesejoSemTexto('/quero   ', 'GitOrchAI_bot')).toBe(true)
    expect(ehPedidoDeDesejoSemTexto('/desejo@GitOrchAI_bot', 'GitOrchAI_bot')).toBe(true)
  })

  it('comando COM pedido não é "sem texto"', () => {
    expect(ehPedidoDeDesejoSemTexto('/desejo quero busca por cor', 'GitOrchAI_bot')).toBe(false)
  })

  it('erro de digitação não é o nosso comando, então não é "sem texto"', () => {
    // O mesmo delimitador que impede "/desejos" de virar o pedido "s" impede
    // que ele arranque uma resposta nossa.
    expect(ehPedidoDeDesejoSemTexto('/desejos', 'GitOrchAI_bot')).toBe(false)
    expect(ehPedidoDeDesejoSemTexto('/quero-relatorio', 'GitOrchAI_bot')).toBe(false)
  })

  it('comando de outro bot no grupo não é nosso nem para ensinar', () => {
    expect(ehPedidoDeDesejoSemTexto('/desejo@OutroBot', 'GitOrchAI_bot')).toBe(false)
  })

  it('mensagem solta não é comando nenhum', () => {
    expect(ehPedidoDeDesejoSemTexto('bom dia', 'GitOrchAI_bot')).toBe(false)
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

// O corpo da issue que o pedido gerou. Falha alto quando nem houve chamada:
// asserção sobre uma issue que não existe passaria despercebida.
function corpoDaIssueCriada(deps: TelegramDesejoDeps): string {
  const chamadas = (deps.criarIssue as ReturnType<typeof vi.fn>).mock.calls
  const primeira = chamadas[0]?.[0] as { corpo?: unknown } | undefined
  if (typeof primeira?.corpo !== 'string') throw new Error('nenhuma issue foi criada')
  return primeira.corpo
}

function deps(over: Partial<TelegramDesejoDeps> = {}): TelegramDesejoDeps {
  return {
    donoDoChat: vi.fn().mockResolvedValue({ tipo: 'unico', userId: 'user_a' }),
    projetosDoDono: vi.fn().mockResolvedValue([PROJETO_UNICO]),
    confirmarAcesso: vi.fn().mockResolvedValue(true),
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

  /**
   * A MESMA reconferência da porta HTTP, aqui: o acesso era provado uma vez, no
   * cadastro, e o endereço nunca mais era conferido. Removida da organização
   * depois, a pessoa continuaria mandando pedido para o repositório alheio — e
   * o produto escreveria lá com a credencial da instalação.
   */
  it('dono que PERDEU o acesso ao repositório não escreve mais nele', async () => {
    const d = deps({ confirmarAcesso: vi.fn().mockResolvedValue(false) })
    const r = await tratarPedidoDeDesejo(d, updateComTexto('/desejo quero busca por cor'))
    expect(d.criarIssue).not.toHaveBeenCalled()
    expect(r?.chatId).toBe('555')
    expect(r?.text).toMatch(/acesso/i)
  })

  it('a prova é feita para o repositório escolhido e o dono do vínculo', async () => {
    const confirmarAcesso = vi.fn().mockResolvedValue(true)
    const d = deps({ confirmarAcesso })
    await tratarPedidoDeDesejo(d, updateComTexto('/desejo quero busca por cor'))
    expect(confirmarAcesso).toHaveBeenCalledWith('dono/loja', 'user_a')
  })

  it('GitHub indisponível na hora de conferir vira recusa TEMPORÁRIA, não permissão', async () => {
    const d = deps({
      confirmarAcesso: vi.fn().mockRejectedValue(new AcessoNaoVerificavelError('ECONNRESET')),
    })
    const r = await tratarPedidoDeDesejo(d, updateComTexto('/desejo quero busca por cor'))
    expect(d.criarIssue).not.toHaveBeenCalled()
    expect(r?.text).toMatch(/agora|minutos|instantes/i)
  })

  /**
   * A credencial revogada saía com a frase da indisponibilidade — "tente de
   * novo em alguns minutos" —, e nenhuma tentativa ressuscita um token
   * revogado. No chat, onde ninguém abre painel de erro, essa frase era a
   * única informação que o dono tinha: ele repetiria o pedido para sempre.
   */
  it('credencial do GitHub revogada manda RECONECTAR, não esperar alguns minutos', async () => {
    const d = deps({
      confirmarAcesso: vi
        .fn()
        .mockRejectedValue(new CredencialDoGithubInvalidaError('HTTP 401 Bad credentials')),
    })
    const r = await tratarPedidoDeDesejo(d, updateComTexto('/desejo quero busca por cor'))
    expect(d.criarIssue).not.toHaveBeenCalled()
    expect(r?.text).toMatch(/reconect/i)
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

  // L4-T8 (fix-up): "ao nascer" a issue de desejo pelo Telegram precisa do
  // `projectId` do projeto ESCOLHIDO — é o que permite a quem monta o
  // `criarIssue` real (plugins/telegram.ts) resolver o quadro e a
  // credencial pelo caminho único e anexar a issue ao quadro ao nascer.
  it('passa o projectId do projeto escolhido para criarIssue — é o que permite achar o quadro depois', async () => {
    const d = deps()
    await tratarPedidoDeDesejo(d, updateComTexto('/desejo quero avaliação com foto'))
    expect(d.criarIssue).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1' }))
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

  // O nome NÃO identifica projeto: o banco só garante @@unique([userId, wingId]),
  // então o mesmo dono pode ter dois projetos chamados "Loja". Escolher o
  // primeiro deixaria o segundo inalcançável para sempre — e o pedido cairia no
  // repositório errado sem ninguém perceber.
  const DOIS_COM_MESMO_NOME: ProjetoParaDesejo[] = [
    { id: 'p1', nome: 'Loja', repo: 'dono/loja-antiga' },
    { id: 'p2', nome: 'Loja', repo: 'dono/loja-nova' },
  ]

  it('o endereço do repositório escolhe o projeto, mesmo com nomes repetidos', async () => {
    const d = deps({ projetosDoDono: vi.fn().mockResolvedValue(DOIS_COM_MESMO_NOME) })
    await tratarPedidoDeDesejo(d, updateComTexto('/desejo dono/loja-nova: quero busca por cor'))
    expect(d.criarIssue).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'dono/loja-nova', titulo: 'quero busca por cor' })
    )
  })

  it('nome repetido não escolhe no escuro: o bot pergunta de novo', async () => {
    const d = deps({ projetosDoDono: vi.fn().mockResolvedValue(DOIS_COM_MESMO_NOME) })
    const r = await tratarPedidoDeDesejo(d, updateComTexto('/desejo Loja: quero busca por cor'))
    expect(d.criarIssue).not.toHaveBeenCalled()
    expect(r?.text).toContain('dono/loja-antiga')
    expect(r?.text).toContain('dono/loja-nova')
  })

  it('a lista de desambiguação mostra o endereço do repositório, que é único', async () => {
    const d = deps({ projetosDoDono: vi.fn().mockResolvedValue(DOIS_COM_MESMO_NOME) })
    const r = await tratarPedidoDeDesejo(d, updateComTexto('/desejo quero busca por cor'))
    expect(d.criarIssue).not.toHaveBeenCalled()
    expect(r?.text).toContain('dono/loja-antiga')
    expect(r?.text).toContain('dono/loja-nova')
  })

  // O laço de escuta do bot é ÚNICO e sequencial: uma chamada ao GitHub sem
  // prazo pendura TODO o bot — inclusive o "/start <token>" de outro cliente no
  // meio do wizard. O prazo transforma um travamento indefinido numa recusa.
  it('GitHub pendurado não trava o bot: o prazo estoura e o dono é avisado', async () => {
    const registrarFalha = vi.fn()
    const d = deps({
      criarIssue: vi.fn().mockImplementation(() => new Promise(() => {})),
      registrarFalha,
      prazoDaIssueMs: 5,
    })
    const r = await tratarPedidoDeDesejo(d, updateComTexto('/desejo quero busca por cor'))
    expect(r?.text).toMatch(/não consegui|nao consegui/i)
    expect(registrarFalha).toHaveBeenCalled()
  })

  // O corpo da issue é lido por gente (o analista, e o próprio dono depois). Um
  // identificador interno do banco não diz nada a ninguém; o Telegram entrega o
  // nome e o @ de quem digitou junto com a mensagem.
  it('o corpo da issue diz quem pediu com nome e @, não com o id interno', async () => {
    const d = deps()
    await tratarPedidoDeDesejo(d, {
      update_id: 1,
      message: {
        chat: { id: 555 },
        text: '/desejo quero busca por cor',
        from: {
          id: 555,
          language_code: 'pt-BR',
          username: 'guilherme',
          first_name: 'Guilherme',
          last_name: 'Souza',
        },
      },
    })
    const corpo = corpoDaIssueCriada(d)
    expect(corpo).toContain('Guilherme Souza')
    expect(corpo).toContain('@guilherme')
    expect(corpo).not.toContain('user_a')
  })

  it('sem nome nem @ no Telegram, cai no identificador da conta em vez de mentir', async () => {
    const d = deps()
    await tratarPedidoDeDesejo(d, updateComTexto('/desejo quero busca por cor'))
    const corpo = corpoDaIssueCriada(d)
    expect(corpo).toContain('user_a')
  })

  // Quem digita só "/desejo" está PERGUNTANDO como o comando funciona. Ficar
  // calado é, do lado de quem usa, indistinguível de "o bot está fora do ar" —
  // e a pessoa desiste do recurso achando que ele não existe.
  it('/desejo sem texto ensina como usar, em vez de deixar a pessoa no vácuo', async () => {
    const d = deps()
    const r = await tratarPedidoDeDesejo(d, updateComTexto('/desejo'))
    expect(r?.chatId).toBe('555')
    expect(r?.text).toContain('/desejo ')
    expect(d.criarIssue).not.toHaveBeenCalled()
  })

  it('/desejo só com espaço também ensina — espaço não é pedido', async () => {
    const d = deps()
    const r = await tratarPedidoDeDesejo(d, updateComTexto('/desejo    '))
    expect(r?.text).toContain('/desejo ')
    expect(d.criarIssue).not.toHaveBeenCalled()
  })

  it('/desejo@nosso_bot sem texto, no grupo, também ensina', async () => {
    const d = deps({ nomeDoBot: 'GitOrchAI_bot' })
    const r = await tratarPedidoDeDesejo(d, updateComTexto('/desejo@GitOrchAI_bot'))
    expect(r?.text).toContain('/desejo ')
    expect(d.criarIssue).not.toHaveBeenCalled()
  })

  // O erro de digitação continua não sendo o nosso comando: nem vira o pedido
  // "s", nem provoca resposta nossa. Responder aqui ensinaria o bot a falar
  // sozinho em cima de comando alheio.
  it('/desejos (plural) continua não sendo assunto nosso — nem pedido, nem resposta', async () => {
    const d = deps()
    expect(await tratarPedidoDeDesejo(d, updateComTexto('/desejos'))).toBeNull()
    expect(d.criarIssue).not.toHaveBeenCalled()
  })

  it('comando sem texto endereçado a OUTRO bot não é respondido por nós', async () => {
    const d = deps({ nomeDoBot: 'GitOrchAI_bot' })
    expect(await tratarPedidoDeDesejo(d, updateComTexto('/desejo@OutroBot'))).toBeNull()
    expect(d.criarIssue).not.toHaveBeenCalled()
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
