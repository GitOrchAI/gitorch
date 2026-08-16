import { describe, expect, it, vi } from 'vitest'
import {
  avisoAindaVale,
  enviarDesejo,
  estadoDaTelaDePedir,
  fetchProjetos,
  LIMITE_DO_TEXTO_DO_DESEJO,
  type DesejoRegistrado,
  type ProjetoDoPainel,
} from './desejo'

// A tela de pedir é a porta de entrada do desejo pelo navegador. O que estes
// testes travam: (a) o pedido só sai daqui quando tem texto E projeto — dedo
// escorregado nunca vira issue; (b) toda falha do backend vira uma CHAVE de
// texto, nunca a mensagem crua do servidor (que pode carregar detalhe interno);
// (c) listar os projetos nunca derruba o painel; (d) a tela nunca AFIRMA
// "você não tem projeto" quando na verdade ela ainda não sabe ou não conseguiu
// saber — os três casos são distintos e têm de continuar distintos.

const okResponse = (status: number, json: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => json }) as unknown as Response

const projeto = (overrides: Partial<ProjetoDoPainel> = {}): ProjetoDoPainel => ({
  id: 'p1',
  repo: 'dono/repo',
  ...overrides,
})

describe('fetchProjetos — de onde a tela tira a lista de projetos do dono', () => {
  // A tela tem de oferecer EXATAMENTE os projetos que o servidor aceita. Ela
  // deduzia a lista da tela de setup, que filtra por dono e por missão de setup
  // e NÃO olha se o projeto está ativo — enquanto o envio exige projeto ativo.
  // Daí os dois erros opostos: oferecer um projeto e, no clique, dizer que
  // aquele mesmo projeto "não está disponível"; e esconder projeto criado por
  // outro caminho, que o servidor teria aceitado. A fonte agora é a rota que
  // usa a MESMA regra do envio.
  it('pergunta ao servidor quais projetos aceitam pedido — a mesma regra do envio', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse(200, {
        projetos: [
          { id: 'p1', nome: 'Loja', repo: 'dono/repo' },
          { id: 'p2', nome: 'Outro', repo: 'dono/outro' },
        ],
      })
    )

    const r = await fetchProjetos('http://api.test', { fetchImpl })

    expect(r).toEqual({
      estado: 'ok',
      projetos: [projeto(), projeto({ id: 'p2', repo: 'dono/outro' })],
    })
    expect(fetchImpl).toHaveBeenCalledWith('http://api.test/api/v1/desejos/projetos', {
      credentials: 'include',
    })
  })

  it('não repete o mesmo projeto, venha ele repetido de onde vier', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse(200, {
        projetos: [
          { id: 'p1', repo: 'dono/repo' },
          { id: 'p1', repo: 'dono/repo' },
        ],
      })
    )

    await expect(fetchProjetos('http://api.test', { fetchImpl })).resolves.toEqual({
      estado: 'ok',
      projetos: [projeto()],
    })
  })

  it('resposta REAL sem projeto nenhum é a única coisa que significa "não tem projeto"', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(200, { projetos: [] }))

    await expect(fetchProjetos('http://api.test', { fetchImpl })).resolves.toEqual({
      estado: 'ok',
      projetos: [],
    })
  })

  it.each([
    ['sessão vencida', vi.fn<typeof fetch>(async () => okResponse(401, { error: 'x' }))],
    ['backend fora', vi.fn<typeof fetch>(async () => okResponse(500, { error: 'x' }))],
    ['excesso de chamadas', vi.fn<typeof fetch>(async () => okResponse(429, { error: 'x' }))],
    [
      'corpo fora do formato',
      vi.fn<typeof fetch>(async () => okResponse(200, { projetos: 'nada disso' })),
    ],
    [
      'rede caída',
      vi.fn<typeof fetch>(async () => {
        throw new Error('offline')
      }),
    ],
  ])(
    '%s não vira "nenhum projeto": volta marcado como não-verificado, sem exceção',
    async (_caso, fetchImpl) => {
      // Este é o defeito que a revisão pegou: enquanto a falha virava lista
      // vazia, o painel dizia a quem JÁ concluiu o setup que ele não tem
      // projeto — afirmando o que não sabe.
      await expect(fetchProjetos('http://api.test', { fetchImpl })).resolves.toEqual({
        estado: 'indisponivel',
      })
    }
  )

  it('descarta item sem id ou sem repositório em vez de perder a lista inteira', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse(200, {
        projetos: [{ id: 'p1', repo: 'dono/repo' }, { id: null, repo: 'dono/orfao' }, { id: 'p3' }],
      })
    )

    await expect(fetchProjetos('http://api.test', { fetchImpl })).resolves.toEqual({
      estado: 'ok',
      projetos: [projeto()],
    })
  })
})

describe('estadoDaTelaDePedir — o que a tela pode AFIRMAR sobre os projetos', () => {
  it('antes da resposta chegar, a tela está carregando — não é "sem projeto"', () => {
    // O caso que aparecia em TODA carga de página: entre o login confirmar e a
    // lista chegar, a tela mandava o dono refazer um setup já concluído.
    expect(estadoDaTelaDePedir(null)).toBe('carregando')
  })

  it('falha na busca é "não consegui verificar", nunca "sem projeto"', () => {
    expect(estadoDaTelaDePedir({ estado: 'indisponivel' })).toBe('indisponivel')
  })

  it('só uma resposta real e vazia autoriza dizer "sem projeto"', () => {
    expect(estadoDaTelaDePedir({ estado: 'ok', projetos: [] })).toBe('semProjeto')
  })

  it('com projeto na mão, o formulário é oferecido', () => {
    expect(estadoDaTelaDePedir({ estado: 'ok', projetos: [projeto()] })).toBe('pronto')
  })
})

describe('enviarDesejo — o pedido em linguagem de gente vira issue', () => {
  it('sucesso: devolve o número e o endereço da issue criada', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse(201, { numero: 77, endereco: 'https://github.com/dono/repo/issues/77' })
    )

    const r = await enviarDesejo(
      { apiBaseUrl: 'http://api.test', projectId: 'p1', texto: '  quero avaliação com foto  ' },
      { fetchImpl }
    )

    expect(r).toEqual({
      ok: true,
      numero: 77,
      endereco: 'https://github.com/dono/repo/issues/77',
    })
    expect(fetchImpl).toHaveBeenCalledWith('http://api.test/api/v1/desejos', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'p1', texto: 'quero avaliação com foto' }),
    })
  })

  it('texto só com espaço não chega a sair do navegador', async () => {
    const fetchImpl = vi.fn<typeof fetch>()

    const r = await enviarDesejo(
      { apiBaseUrl: 'http://api.test', projectId: 'p1', texto: '   ' },
      { fetchImpl }
    )

    expect(r).toEqual({ ok: false, chaveDoErro: 'dashboard.wishErrorEmpty' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  // Dois fatos diferentes, duas frases diferentes. "Você não escolheu projeto"
  // é uma instrução do que fazer agora; "esse projeto não é seu" é uma recusa.
  // Enquanto os dois dividiam a mesma chave, quem só esqueceu de escolher lia
  // que o projeto dele não estava disponível — e ia procurar um problema que
  // não existia.
  it('sem projeto escolhido, a tela manda escolher — não diz que o projeto é inválido', async () => {
    const fetchImpl = vi.fn<typeof fetch>()

    const r = await enviarDesejo(
      { apiBaseUrl: 'http://api.test', projectId: '', texto: 'quero busca por cor' },
      { fetchImpl }
    )

    expect(r).toEqual({ ok: false, chaveDoErro: 'dashboard.wishErrorNoProject' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  // O corpo de uma issue do GitHub tem teto de 65.536 caracteres. Um texto
  // colado acima disso era recusado com 422, virava 502 na rota e chegava à
  // tela como "tente de novo em instantes" — conselho que NUNCA ia funcionar,
  // por mais vezes que a pessoa tentasse.
  it('texto maior que o teto do GitHub não sai do navegador e diz o motivo real', async () => {
    const fetchImpl = vi.fn<typeof fetch>()

    const r = await enviarDesejo(
      {
        apiBaseUrl: 'http://api.test',
        projectId: 'p1',
        texto: 'a'.repeat(LIMITE_DO_TEXTO_DO_DESEJO + 1),
      },
      { fetchImpl }
    )

    expect(r).toEqual({ ok: false, chaveDoErro: 'dashboard.wishErrorTooLong' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('texto exatamente no limite ainda é aceito', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(201, { numero: 1, endereco: '' }))

    const r = await enviarDesejo(
      {
        apiBaseUrl: 'http://api.test',
        projectId: 'p1',
        texto: 'a'.repeat(LIMITE_DO_TEXTO_DO_DESEJO),
      },
      { fetchImpl }
    )

    expect(r.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalled()
  })

  it('o limite fica abaixo do teto do GitHub, com folga para o rodapé do corpo', () => {
    expect(LIMITE_DO_TEXTO_DO_DESEJO).toBeLessThan(65_536)
  })

  it.each([
    [400, 'dashboard.wishErrorEmpty'],
    [401, 'dashboard.wishErrorSession'],
    // 403 nesta rota é UM fato só: o dono perdeu o acesso de escrita ao
    // repositório do projeto (o servidor reconfere no GitHub na hora de
    // registrar). Enquanto caía junto com o 401, a tela mandava a pessoa
    // entrar de novo — e entrar de novo não devolve acesso a repositório
    // nenhum: ela repetiria o login para sempre sem entender o motivo.
    [403, 'dashboard.wishErrorRepoAccess'],
    [404, 'dashboard.wishErrorProject'],
    // O servidor também tem o teto de tamanho, e recusa com 413. Sem esta
    // linha, um texto grande vindo de um navegador sem o `maxLength` chegaria
    // à tela como "tente de novo em instantes" — o conselho que nunca funciona.
    [413, 'dashboard.wishErrorTooLong'],
    [502, 'dashboard.wishErrorGithub'],
    [500, 'dashboard.wishErrorGithub'],
    // Indisponibilidade tem nome próprio: o servidor não conseguiu confirmar
    // com o GitHub agora. Não é "seu pedido falhou", é "tente de novo".
    [503, 'dashboard.wishErrorRepoUnverified'],
  ])('recusa %s vira a chave de texto %s', async (status, chaveDoErro) => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse(status, { error: 'token ghp_segredo inválido' })
    )

    const r = await enviarDesejo(
      { apiBaseUrl: 'http://api.test', projectId: 'p1', texto: 'oi' },
      { fetchImpl }
    )

    expect(r).toEqual({ ok: false, chaveDoErro })
  })

  it('nunca repassa a mensagem crua do servidor para a tela', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse(502, { error: 'token ghp_segredo inválido' })
    )

    const r = await enviarDesejo(
      { apiBaseUrl: 'http://api.test', projectId: 'p1', texto: 'oi' },
      { fetchImpl }
    )

    expect(JSON.stringify(r)).not.toContain('ghp_')
  })

  it('rede caída vira erro de rede, não uma exceção solta na tela', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('offline')
    })

    const r = await enviarDesejo(
      { apiBaseUrl: 'http://api.test', projectId: 'p1', texto: 'oi' },
      { fetchImpl }
    )

    expect(r).toEqual({ ok: false, chaveDoErro: 'dashboard.wishErrorNetwork' })
  })

  it('sucesso sem número no corpo não vira "criado" mentiroso', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(201, { endereco: 'https://x/1' }))

    const r = await enviarDesejo(
      { apiBaseUrl: 'http://api.test', projectId: 'p1', texto: 'oi' },
      { fetchImpl }
    )

    expect(r).toEqual({ ok: false, chaveDoErro: 'dashboard.wishErrorGithub' })
  })
})

// O aviso de "registrado como #77" descreve UM pedido, num projeto. Quando a
// tela deixa de descrever esse pedido — porque o dono trocou de projeto, ou já
// começou a escrever o próximo —, o aviso vira uma afirmação sobre outra coisa.
// Quem bate o olho lê "registrado" e acha que já mandou.
describe('avisoAindaVale — quando o aviso de sucesso ainda descreve a tela', () => {
  const aviso: DesejoRegistrado = {
    numero: 77,
    endereco: 'https://github.com/dono/repo/issues/77',
    projectId: 'p1',
    repo: 'dono/repo',
  }

  it('sem aviso não há nada a mostrar', () => {
    expect(avisoAindaVale(null, { projectId: 'p1', texto: '' })).toBe(false)
  })

  it('logo depois do envio, com a caixa limpa, o aviso vale', () => {
    expect(avisoAindaVale(aviso, { projectId: 'p1', texto: '' })).toBe(true)
  })

  it('trocar de projeto tira o aviso: ele era sobre o projeto anterior', () => {
    expect(avisoAindaVale(aviso, { projectId: 'p2', texto: '' })).toBe(false)
  })

  it('começar a escrever o próximo pedido tira o aviso do pedido anterior', () => {
    expect(avisoAindaVale(aviso, { projectId: 'p1', texto: 'quero também busca por cor' })).toBe(
      false
    )
  })

  it('espaço em branco na caixa não conta como pedido novo', () => {
    expect(avisoAindaVale(aviso, { projectId: 'p1', texto: '   ' })).toBe(true)
  })
})
