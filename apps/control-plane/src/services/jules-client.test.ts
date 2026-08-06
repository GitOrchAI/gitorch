import { describe, it, expect } from 'vitest'
import { julesSourceName, criarSessaoJules } from './jules-client.js'

// Desejo do dono (issue de wishlist deste repositório): delegar tem de ACIONAR
// o dev assíncrono, não apenas pendurar um label e torcer para alguém escutar.
//
// Medido antes desta mudança: o SM delegou (label aplicado numa issue P0),
// passaram-se 13 missões e nenhum PR apareceu — o repositório sequer estava
// conectado na conta do serviço. O label é uma campainha muda; a sessão criada
// pela API tem identificador, e identificador dá para acompanhar e cobrar.

describe('julesSourceName', () => {
  it('traduz dono/repo para o identificador que a API espera', () => {
    expect(julesSourceName('GitOrchAI/gitorch')).toBe('sources/github/GitOrchAI/gitorch')
  })

  it('repositório malformado não vira chamada', () => {
    expect(julesSourceName('sem-barra')).toBeNull()
    expect(julesSourceName('')).toBeNull()
  })
})

describe('criarSessaoJules', () => {
  const fetchFake = (respostas: Array<{ ok: boolean; status: number; body: unknown }>) => {
    const chamadas: Array<{ url: string; init: RequestInit | undefined }> = []
    let i = 0
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      chamadas.push({ url: String(url), init })
      const r = respostas[Math.min(i++, respostas.length - 1)]!
      return { ok: r.ok, status: r.status, json: async () => r.body } as unknown as Response
    }) as unknown as typeof fetch
    return { impl, chamadas }
  }

  const base = {
    apiKey: 'chave',
    repository: 'GitOrchAI/gitorch',
    startingBranch: 'main',
    titulo: '[Task] Corrigir emissão de token',
    prompt: '## Goal\n\nGarantir que o token alcance o repositório.',
  }

  it('cria a sessão com o repositório, o branch e o pedido de PR automático', async () => {
    const { impl, chamadas } = fetchFake([
      { ok: true, status: 200, body: { name: 'sessions/abc123' } },
    ])

    const sessao = await criarSessaoJules({ ...base, fetchImpl: impl })

    expect(sessao).toBe('sessions/abc123')
    const req = chamadas[0]!
    expect(req.url).toContain('/v1alpha/sessions')
    expect((req.init!.headers as Record<string, string>)['X-Goog-Api-Key']).toBe('chave')
    const corpo = JSON.parse(String(req.init!.body))
    expect(corpo.sourceContext.source).toBe('sources/github/GitOrchAI/gitorch')
    expect(corpo.sourceContext.githubRepoContext.startingBranch).toBe('main')
    expect(corpo.automationMode).toBe('AUTO_CREATE_PR')
    expect(corpo.prompt).toContain('Goal')
    expect(corpo.title).toContain('Corrigir emissão de token')
  })

  it('sem chave configurada: não toca a rede e devolve null (o label segue como plano B)', async () => {
    const { impl, chamadas } = fetchFake([{ ok: true, status: 200, body: {} }])
    const sessao = await criarSessaoJules({ ...base, apiKey: undefined, fetchImpl: impl })

    expect(sessao).toBeNull()
    expect(chamadas).toHaveLength(0)
  })

  it('repositório não conectado na conta: avisa o que fazer, sem quebrar a delegação', async () => {
    const avisos: string[] = []
    const { impl } = fetchFake([
      { ok: false, status: 404, body: { error: { message: 'source not found' } } },
    ])

    const sessao = await criarSessaoJules({
      ...base,
      fetchImpl: impl,
      onWarn: (m) => avisos.push(m),
    })

    expect(sessao).toBeNull()
    expect(avisos.join(' ')).toContain('GitOrchAI/gitorch')
    expect(avisos.join(' ').toLowerCase()).toContain('conect')
  })

  it('serviço fora do ar nunca derruba o trabalho do SM', async () => {
    const avisos: string[] = []
    const impl = (async () => {
      throw new Error('rede caiu')
    }) as unknown as typeof fetch

    await expect(
      criarSessaoJules({ ...base, fetchImpl: impl, onWarn: (m) => avisos.push(m) })
    ).resolves.toBeNull()
    expect(avisos.length).toBeGreaterThan(0)
  })
})
