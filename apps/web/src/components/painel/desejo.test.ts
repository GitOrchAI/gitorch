import { describe, expect, it, vi } from 'vitest'
import { enviarDesejo, fetchProjetos, type ProjetoDoPainel } from './desejo'

// A tela de pedir é a porta de entrada do desejo pelo navegador. O que estes
// testes travam: (a) o pedido só sai daqui quando tem texto E projeto — dedo
// escorregado nunca vira issue; (b) toda falha do backend vira uma CHAVE de
// texto, nunca a mensagem crua do servidor (que pode carregar detalhe interno);
// (c) listar os projetos nunca derruba o painel.

const okResponse = (status: number, json: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => json }) as unknown as Response

const projeto = (overrides: Partial<ProjetoDoPainel> = {}): ProjetoDoPainel => ({
  id: 'p1',
  repo: 'dono/repo',
  ...overrides,
})

describe('fetchProjetos — de onde a tela tira a lista de projetos do dono', () => {
  it('lê os projetos do estado do setup, sem repetir o mesmo projeto', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse(200, {
        status: 'completed',
        missions: [
          { projectId: 'p1', wingId: 'dono/repo', status: 'completed' },
          { projectId: 'p2', wingId: 'dono/outro', status: 'running' },
          { projectId: 'p1', wingId: 'dono/repo', status: 'completed' },
        ],
      })
    )

    const projetos = await fetchProjetos('http://api.test', { fetchImpl })

    expect(projetos).toEqual([projeto(), projeto({ id: 'p2', repo: 'dono/outro' })])
    expect(fetchImpl).toHaveBeenCalledWith('http://api.test/api/v1/setup/status', {
      credentials: 'include',
    })
  })

  it('sessão ausente, backend fora ou corpo torto viram lista vazia, nunca exceção', async () => {
    const semSessao = vi.fn<typeof fetch>(async () => okResponse(401, { error: 'x' }))
    const corpoTorto = vi.fn<typeof fetch>(async () => okResponse(200, { missions: 'nada disso' }))
    const redeCaida = vi.fn<typeof fetch>(async () => {
      throw new Error('offline')
    })

    await expect(fetchProjetos('http://api.test', { fetchImpl: semSessao })).resolves.toEqual([])
    await expect(fetchProjetos('http://api.test', { fetchImpl: corpoTorto })).resolves.toEqual([])
    await expect(fetchProjetos('http://api.test', { fetchImpl: redeCaida })).resolves.toEqual([])
  })

  it('descarta item sem projectId ou sem repositório em vez de perder a lista inteira', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse(200, {
        missions: [
          { projectId: 'p1', wingId: 'dono/repo' },
          { projectId: null, wingId: 'dono/orfao' },
          { projectId: 'p3' },
        ],
      })
    )

    await expect(fetchProjetos('http://api.test', { fetchImpl })).resolves.toEqual([projeto()])
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

  it('sem projeto escolhido não sai pedido nenhum', async () => {
    const fetchImpl = vi.fn<typeof fetch>()

    const r = await enviarDesejo(
      { apiBaseUrl: 'http://api.test', projectId: '', texto: 'quero busca por cor' },
      { fetchImpl }
    )

    expect(r).toEqual({ ok: false, chaveDoErro: 'dashboard.wishErrorProject' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    [400, 'dashboard.wishErrorEmpty'],
    [401, 'dashboard.wishErrorSession'],
    [404, 'dashboard.wishErrorProject'],
    [502, 'dashboard.wishErrorGithub'],
    [500, 'dashboard.wishErrorGithub'],
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
