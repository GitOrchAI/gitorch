import { describe, expect, it, vi } from 'vitest'
import { fetchRespostasAoDev, type RespostaAoDevView } from './respostas-ao-dev'

// D69 (02/09): o dono quer VER no painel as respostas que o time deu ao dev
// em seu nome — GET /api/v1/painel/respostas-ao-dev (control-plane). Mesma
// disciplina de agent-questions.ts: NUNCA lança (sessão ausente, backend
// fora, JSON torto ou rede caída sempre viram lista vazia), e a `lacuna`
// (o que falta nesta seção) vem do PRÓPRIO servidor — o front nunca inventa
// o texto da lacuna, só repassa o que a rota disser.

const okResponse = (json: unknown): Response =>
  ({ ok: true, status: 200, json: async () => json }) as unknown as Response

const failResponse = (status: number): Response =>
  ({ ok: false, status, json: async () => ({}) }) as unknown as Response

const item = (overrides: Partial<RespostaAoDevView> = {}): RespostaAoDevView => ({
  id: 'evt_1',
  projeto: 'acme/api',
  issueNumber: 46,
  quando: '2026-09-01T10:00:00.000Z',
  resumo: 'Pergunta técnica -> resposta: use o padrão X.',
  corrigidoEm: null,
  ...overrides,
})

describe('fetchRespostasAoDev — busca as respostas dadas ao dev, nunca lança', () => {
  it('backend ok -> parseia itens e a lacuna', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse({
        itens: [
          {
            id: 'evt_1',
            projeto: 'acme/api',
            issueNumber: 46,
            quando: '2026-09-01T10:00:00.000Z',
            resumo: 'Pergunta técnica -> resposta: use o padrão X.',
            corrigidoEm: null,
          },
        ],
        lacuna: 'O produto ainda não guarda o texto exato enviado ao dev.',
      })
    )

    const result = await fetchRespostasAoDev('http://api.test', { fetchImpl })

    expect(result).toEqual({
      itens: [item()],
      lacuna: 'O produto ainda não guarda o texto exato enviado ao dev.',
    })
    expect(fetchImpl).toHaveBeenCalledWith('http://api.test/api/v1/painel/respostas-ao-dev', {
      credentials: 'include',
    })
  })

  it('sessão ausente (401) -> itens vazio, lacuna vazia (nunca lança)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => failResponse(401))
    const result = await fetchRespostasAoDev('http://api.test', { fetchImpl })
    expect(result).toEqual({ itens: [], lacuna: '' })
  })

  it('rede fora -> itens vazio, lacuna vazia (nunca lança)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('ECONNRESET')
    })
    const result = await fetchRespostasAoDev('http://api.test', { fetchImpl })
    expect(result).toEqual({ itens: [], lacuna: '' })
  })

  it('JSON torto (sem itens array) -> itens vazio, nunca espalha undefined', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => okResponse({ algumaOutraCoisa: true }))
    const result = await fetchRespostasAoDev('http://api.test', { fetchImpl })
    expect(result).toEqual({ itens: [], lacuna: '' })
  })

  it('item torto na lista (sem resumo) é descartado, o resto continua aparecendo', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse({
        itens: [{ id: 'evt_torto' }, item({ id: 'evt_bom' })],
        lacuna: 'x',
      })
    )
    const result = await fetchRespostasAoDev('http://api.test', { fetchImpl })
    expect(result.itens).toEqual([item({ id: 'evt_bom' })])
  })
})
