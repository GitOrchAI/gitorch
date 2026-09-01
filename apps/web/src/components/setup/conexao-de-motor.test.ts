import { describe, it, expect } from 'vitest'
import { criarConexaoDeMotores, type StreamDeLogin } from './conexao-de-motor'

// O MIOLO do passo 7 do assistente, agora fora do React: é ele que o painel
// passou a usar para religar o motor NO LUGAR onde o dono clicou, em vez de
// mandá-lo para /setup.
//
// Cada teste aqui confere RESULTADO — o estado que o card passa a ter, ou a
// requisição que de fato saiu — nunca "a função foi chamada".

interface Chamada {
  url: string
  init: RequestInit | undefined
}

function resposta(corpo: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => corpo } as unknown as Response
}

/** fetch de mentira que responde por trecho de URL e grava o que saiu. */
function fetchFalso(mapa: Array<[string, () => Promise<Response>]>): {
  impl: typeof fetch
  chamadas: Chamada[]
} {
  const chamadas: Chamada[] = []
  const impl = (async (url: string, init?: RequestInit) => {
    chamadas.push({ url: String(url), init })
    for (const [trecho, r] of mapa) if (String(url).includes(trecho)) return r()
    throw new Error(`rota não prevista no teste: ${String(url)}`)
  }) as unknown as typeof fetch
  return { impl, chamadas }
}

interface StreamAberto {
  url: string
  fechado: boolean
  emitir: (raw: unknown) => void
  quebrar: () => void
}

/** Stream de mentira: o teste empurra os eventos na mão. */
function streamsFalsos(): {
  abrir: (url: string, aoEstado: (raw: unknown) => void, aoErro: () => void) => StreamDeLogin
  abertos: StreamAberto[]
} {
  const abertos: StreamAberto[] = []
  const abrir = (
    url: string,
    aoEstado: (raw: unknown) => void,
    aoErro: () => void
  ): StreamDeLogin => {
    const s: StreamAberto = { url, fechado: false, emitir: aoEstado, quebrar: aoErro }
    abertos.push(s)
    return {
      fechar: () => {
        s.fechado = true
      },
    }
  }
  return { abrir, abertos }
}

const ERRO = 'Não deu para conectar. Confira o que você colou e tente de novo.'

describe('conexão de motor — o fluxo compartilhado pelo assistente e pelo painel', () => {
  it('conectar: sai de idle para starting e chega em url_ready com a URL do provedor', async () => {
    const { impl } = fetchFalso([
      ['/login/start', async () => resposta({ loginId: 'L1' }, true, 202)],
    ])
    const st = streamsFalsos()
    const c = criarConexaoDeMotores({
      apiBaseUrl: 'https://api.exemplo',
      erroPadrao: () => ERRO,
      fetchImpl: impl,
      abrirStream: st.abrir,
    })

    await c.conectar('codex', 'codex')
    expect(st.abertos).toHaveLength(1)
    expect(st.abertos[0]!.url).toBe('https://api.exemplo/api/v1/engines/login/L1/stream')

    st.abertos[0]!.emitir({ phase: 'url_ready', url: 'https://provedor/autorizar' })
    expect(c.instantaneo().estados['codex']).toEqual({
      phase: 'url_ready',
      url: 'https://provedor/autorizar',
    })
  })

  it('conectar: a requisição sai no runtime certo, com a sessão por cookie', async () => {
    const f = fetchFalso([['/login/start', async () => resposta({ loginId: 'L1' }, true, 202)]])
    const c = criarConexaoDeMotores({
      apiBaseUrl: 'https://api.exemplo',
      erroPadrao: () => ERRO,
      fetchImpl: f.impl,
      abrirStream: streamsFalsos().abrir,
    })
    await c.conectar('codex', 'codex')
    expect(f.chamadas[0]!.url).toBe('https://api.exemplo/api/v1/engines/codex/login/start')
    expect(f.chamadas[0]!.init?.method).toBe('POST')
    expect(f.chamadas[0]!.init?.credentials).toBe('include')
  })

  it('conectar: erro do servidor vira estado de erro com a causa REAL, não a genérica', async () => {
    const { impl } = fetchFalso([
      ['/login/start', async () => resposta({ error: 'runtime não suportado' }, false, 400)],
    ])
    const c = criarConexaoDeMotores({
      apiBaseUrl: '',
      erroPadrao: () => ERRO,
      fetchImpl: impl,
      abrirStream: streamsFalsos().abrir,
    })
    await c.conectar('codex', 'codex')
    expect(c.instantaneo().estados['codex']).toEqual({
      phase: 'error',
      message: 'runtime não suportado',
    })
  })

  it('conectar: rede caindo no meio vira erro visível, nunca silêncio', async () => {
    const impl = (async () => {
      throw new Error('rede fora')
    }) as unknown as typeof fetch
    const c = criarConexaoDeMotores({
      apiBaseUrl: '',
      erroPadrao: () => ERRO,
      fetchImpl: impl,
      abrirStream: streamsFalsos().abrir,
    })
    await c.conectar('codex', 'codex')
    expect(c.instantaneo().estados['codex']).toEqual({ phase: 'error', message: ERRO })
  })

  it('enviarCodigo: entra em verifying NO CLIQUE, antes de o POST voltar', async () => {
    let liberar: (r: Response) => void = () => {}
    const { impl } = fetchFalso([
      ['/login/start', async () => resposta({ loginId: 'L1' }, true, 202)],
      [
        '/code',
        () =>
          new Promise<Response>((r) => {
            liberar = r
          }),
      ],
    ])
    const st = streamsFalsos()
    const c = criarConexaoDeMotores({
      apiBaseUrl: '',
      erroPadrao: () => ERRO,
      fetchImpl: impl,
      abrirStream: st.abrir,
    })
    await c.conectar('codex', 'codex')
    st.abertos[0]!.emitir({ phase: 'url_ready', url: 'https://provedor/autorizar' })

    const enviando = c.enviarCodigo('codex', ' ABCD-1234 ')
    // O POST ainda NÃO voltou: se a fase continuasse url_ready, o campo e o
    // botão seguiriam à vista e a pessoa clicaria de novo.
    expect(c.instantaneo().estados['codex']).toEqual({ phase: 'verifying' })
    liberar(resposta({ ok: true }))
    await enviando
  })

  it('enviarCodigo: manda o código sem espaços sobrando para a sessão de login certa', async () => {
    const f = fetchFalso([
      ['/login/start', async () => resposta({ loginId: 'L7' }, true, 202)],
      ['/code', async () => resposta({ ok: true })],
    ])
    const c = criarConexaoDeMotores({
      apiBaseUrl: '',
      erroPadrao: () => ERRO,
      fetchImpl: f.impl,
      abrirStream: streamsFalsos().abrir,
    })
    await c.conectar('codex', 'codex')
    await c.enviarCodigo('codex', '  ABCD-1234  ')
    // `includes('/code')` casaria com `/engines/codex/...` — a URL do
    // start. O sufixo é o que separa as duas rotas.
    const post = f.chamadas.find((x) => x.url.endsWith('/code'))!
    expect(post.url).toBe('/api/v1/engines/login/L7/code')
    expect(post.init?.body).toBe(JSON.stringify({ code: 'ABCD-1234' }))
  })

  it('enviarCodigo: 500 no envio vira erro visível — nunca fica girando para sempre', async () => {
    const { impl } = fetchFalso([
      ['/login/start', async () => resposta({ loginId: 'L1' }, true, 202)],
      ['/code', async () => resposta({}, false, 500)],
    ])
    const c = criarConexaoDeMotores({
      apiBaseUrl: '',
      erroPadrao: () => ERRO,
      fetchImpl: impl,
      abrirStream: streamsFalsos().abrir,
    })
    await c.conectar('codex', 'codex')
    await c.enviarCodigo('codex', 'ABCD-1234')
    expect(c.instantaneo().estados['codex']).toEqual({ phase: 'error', message: ERRO })
  })

  it('enviarCodigo sem login começado não inventa estado nenhum', async () => {
    const { impl, chamadas } = fetchFalso([])
    const c = criarConexaoDeMotores({
      apiBaseUrl: '',
      erroPadrao: () => ERRO,
      fetchImpl: impl,
      abrirStream: streamsFalsos().abrir,
    })
    await c.enviarCodigo('codex', 'ABCD-1234')
    expect(c.instantaneo().estados['codex']).toBeUndefined()
    expect(chamadas).toHaveLength(0)
  })

  it('token colado à mão: só vira conectado quando a prova de vida do servidor passou', async () => {
    const { impl } = fetchFalso([
      [
        '/token',
        async () =>
          resposta({
            connected: true,
            status: { status: 'connected', models: ['gpt-5-codex'], quotaRemaining: 12 },
          }),
      ],
    ])
    const c = criarConexaoDeMotores({
      apiBaseUrl: '',
      erroPadrao: () => ERRO,
      fetchImpl: impl,
      abrirStream: streamsFalsos().abrir,
    })
    await c.enviarToken('codex', 'codex', ' sk-exemplo ')
    expect(c.instantaneo().estados['codex']).toEqual({
      phase: 'connected',
      models: ['gpt-5-codex'],
      quota: 12,
    })
  })

  it('token colado à mão: prova de vida reprovada NÃO vira conectado', async () => {
    const { impl } = fetchFalso([
      [
        '/token',
        async () =>
          resposta({
            connected: false,
            status: { status: 'error', lastError: 'credencial inválida' },
          }),
      ],
    ])
    const c = criarConexaoDeMotores({
      apiBaseUrl: '',
      erroPadrao: () => ERRO,
      fetchImpl: impl,
      abrirStream: streamsFalsos().abrir,
    })
    await c.enviarToken('codex', 'codex', 'sk-exemplo')
    expect(c.instantaneo().estados['codex']).toEqual({
      phase: 'error',
      message: 'credencial inválida',
    })
  })

  it('token colado à mão: enquanto está enviando, um segundo clique não manda de novo', async () => {
    let liberar: (r: Response) => void = () => {}
    const f = fetchFalso([
      [
        '/token',
        () =>
          new Promise<Response>((r) => {
            liberar = r
          }),
      ],
    ])
    const c = criarConexaoDeMotores({
      apiBaseUrl: '',
      erroPadrao: () => ERRO,
      fetchImpl: f.impl,
      abrirStream: streamsFalsos().abrir,
    })
    const primeiro = c.enviarToken('codex', 'codex', 'sk-exemplo')
    expect(c.instantaneo().enviandoToken['codex']).toBe(true)
    await c.enviarToken('codex', 'codex', 'sk-exemplo')
    expect(f.chamadas).toHaveLength(1)
    liberar(resposta({ connected: true, status: { status: 'connected' } }))
    await primeiro
    expect(c.instantaneo().enviandoToken['codex']).toBe(false)
  })

  it('estado do servidor: motor vencido aparece como precisa_religar; conectado aparece conectado', async () => {
    const { impl } = fetchFalso([
      [
        '/api/v1/engines',
        async () =>
          resposta({
            engines: [
              { runtime: 'codex', status: 'needs_reconnect' },
              { runtime: 'claude', status: 'connected', models: ['opus'], quotaRemaining: null },
            ],
          }),
      ],
    ])
    const c = criarConexaoDeMotores({
      apiBaseUrl: '',
      erroPadrao: () => ERRO,
      fetchImpl: impl,
      abrirStream: streamsFalsos().abrir,
    })
    await c.carregarDoServidor([
      { id: 'codex', runtime: 'codex' },
      { id: 'claude-code', runtime: 'claude' },
      { id: 'antigravity', runtime: 'antigravity' },
    ])
    expect(c.instantaneo().estados['codex']).toEqual({ phase: 'precisa_religar' })
    expect(c.instantaneo().estados['claude-code']).toEqual({
      phase: 'connected',
      models: ['opus'],
      quota: null,
    })
    // Motor que nunca conectou não ganha estado — o card segue em idle.
    expect(c.instantaneo().estados['antigravity']).toBeUndefined()
  })

  it('estado do servidor NÃO atropela o que a pessoa está fazendo agora', async () => {
    const { impl } = fetchFalso([
      ['/login/start', async () => resposta({ loginId: 'L1' }, true, 202)],
      [
        '/api/v1/engines',
        async () => resposta({ engines: [{ runtime: 'codex', status: 'needs_reconnect' }] }),
      ],
    ])
    const st = streamsFalsos()
    const c = criarConexaoDeMotores({
      apiBaseUrl: '',
      erroPadrao: () => ERRO,
      fetchImpl: impl,
      abrirStream: st.abrir,
    })
    await c.conectar('codex', 'codex')
    st.abertos[0]!.emitir({ phase: 'url_ready', url: 'https://provedor/autorizar' })
    await c.carregarDoServidor([{ id: 'codex', runtime: 'codex' }])
    expect(c.instantaneo().estados['codex']).toEqual({
      phase: 'url_ready',
      url: 'https://provedor/autorizar',
    })
  })

  it('conectar de novo fecha o stream anterior — evento atrasado dele não mexe mais na tela', async () => {
    const { impl } = fetchFalso([
      ['/login/start', async () => resposta({ loginId: 'L1' }, true, 202)],
    ])
    const st = streamsFalsos()
    const c = criarConexaoDeMotores({
      apiBaseUrl: '',
      erroPadrao: () => ERRO,
      fetchImpl: impl,
      abrirStream: st.abrir,
    })
    await c.conectar('codex', 'codex')
    await c.conectar('codex', 'codex')
    expect(st.abertos[0]!.fechado).toBe(true)

    st.abertos[0]!.emitir({ phase: 'error', message: 'lixo do stream velho' })
    expect(c.instantaneo().estados['codex']).toEqual({ phase: 'starting' })

    st.abertos[1]!.emitir({ phase: 'url_ready', url: 'https://provedor/autorizar' })
    expect(c.instantaneo().estados['codex']).toEqual({
      phase: 'url_ready',
      url: 'https://provedor/autorizar',
    })
  })

  it('chegou em connected: o stream fecha e nada mais o reabre por acidente', async () => {
    const { impl } = fetchFalso([
      ['/login/start', async () => resposta({ loginId: 'L1' }, true, 202)],
    ])
    const st = streamsFalsos()
    const c = criarConexaoDeMotores({
      apiBaseUrl: '',
      erroPadrao: () => ERRO,
      fetchImpl: impl,
      abrirStream: st.abrir,
    })
    await c.conectar('codex', 'codex')
    st.abertos[0]!.emitir({ phase: 'connected', models: ['gpt-5-codex'], quota: 3 })
    expect(st.abertos[0]!.fechado).toBe(true)
    st.abertos[0]!.emitir({ phase: 'error', message: 'atrasado' })
    expect(c.instantaneo().estados['codex']).toEqual({
      phase: 'connected',
      models: ['gpt-5-codex'],
      quota: 3,
    })
  })

  it('stream que quebra vira erro na tela, não um card parado para sempre', async () => {
    const { impl } = fetchFalso([
      ['/login/start', async () => resposta({ loginId: 'L1' }, true, 202)],
    ])
    const st = streamsFalsos()
    const c = criarConexaoDeMotores({
      apiBaseUrl: '',
      erroPadrao: () => ERRO,
      fetchImpl: impl,
      abrirStream: st.abrir,
    })
    await c.conectar('codex', 'codex')
    st.abertos[0]!.quebrar()
    expect(c.instantaneo().estados['codex']).toEqual({ phase: 'error', message: ERRO })
    expect(st.abertos[0]!.fechado).toBe(true)
  })

  it('encerrar fecha todos os streams abertos (troca de tela não vaza conexão)', async () => {
    const { impl } = fetchFalso([
      ['/login/start', async () => resposta({ loginId: 'L1' }, true, 202)],
    ])
    const st = streamsFalsos()
    const c = criarConexaoDeMotores({
      apiBaseUrl: '',
      erroPadrao: () => ERRO,
      fetchImpl: impl,
      abrirStream: st.abrir,
    })
    await c.conectar('codex', 'codex')
    await c.conectar('claude-code', 'claude')
    c.encerrar()
    expect(st.abertos.map((s) => s.fechado)).toEqual([true, true])
  })

  it('quem escuta a loja é avisado a cada mudança, e o instantâneo só muda quando algo mudou', async () => {
    const { impl } = fetchFalso([
      ['/login/start', async () => resposta({ loginId: 'L1' }, true, 202)],
    ])
    const st = streamsFalsos()
    const c = criarConexaoDeMotores({
      apiBaseUrl: '',
      erroPadrao: () => ERRO,
      fetchImpl: impl,
      abrirStream: st.abrir,
    })
    const antes = c.instantaneo()
    let avisos = 0
    const parar = c.inscrever(() => {
      avisos += 1
    })
    await c.conectar('codex', 'codex')
    expect(avisos).toBeGreaterThan(0)
    expect(c.instantaneo()).not.toBe(antes)
    const agora = c.instantaneo()
    expect(c.instantaneo()).toBe(agora)
    parar()
    const depoisDeParar = avisos
    st.abertos[0]!.emitir({ phase: 'url_ready', url: 'https://x' })
    expect(avisos).toBe(depoisDeParar)
  })
})
