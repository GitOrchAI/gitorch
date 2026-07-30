import { describe, expect, it, vi } from 'vitest'
import {
  fetchAgentQuestions,
  sortQuestions,
  statusLabel,
  type AgentQuestionView,
} from './agent-questions'

// O painel EXIBE as dúvidas dos agentes (W3.4.2), read-only — responder
// continua sendo só pelo Telegram. O que estes testes travam: o painel NUNCA
// quebra (sessão ausente, backend fora, JSON torto ou rede caída sempre viram
// lista vazia, nunca uma exceção que derrubaria a tela) e a ordenação/rótulos
// que a UI usa pra priorizar o que precisa de atenção.

const okResponse = (json: unknown): Response =>
  ({ ok: true, status: 200, json: async () => json }) as unknown as Response

const failResponse = (status: number): Response =>
  ({ ok: false, status, json: async () => ({}) }) as unknown as Response

const question = (overrides: Partial<AgentQuestionView> = {}): AgentQuestionView => ({
  id: 'q_1',
  text: 'Pergunta padrão',
  context: null,
  options: [],
  status: 'open',
  answer: null,
  answeredAt: null,
  createdAt: '2026-07-20T10:00:00.000Z',
  ...overrides,
})

describe('fetchAgentQuestions — busca as dúvidas do dono, nunca lança', () => {
  it('backend ok -> parseia a lista de questions', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      okResponse({
        questions: [
          {
            id: 'q_1',
            text: 'Qual branch usar?',
            context: 'PR #10 tem duas opções',
            options: [{ label: 'main', value: 'main' }],
            status: 'open',
            answer: null,
            answeredAt: null,
            createdAt: '2026-07-21T09:00:00.000Z',
          },
        ],
      })
    )

    const result = await fetchAgentQuestions('http://api.test', { fetchImpl })

    expect(result).toEqual([
      {
        id: 'q_1',
        text: 'Qual branch usar?',
        context: 'PR #10 tem duas opções',
        options: [{ label: 'main', value: 'main' }],
        status: 'open',
        answer: null,
        answeredAt: null,
        createdAt: '2026-07-21T09:00:00.000Z',
      },
    ])
    const call = fetchImpl.mock.calls[0]
    expect(String(call[0])).toBe('http://api.test/api/v1/setup/agent-questions')
    expect(call[1]).toMatchObject({ credentials: 'include' })
  })

  it('backend responde !ok (401/500) -> lista vazia, nunca lança', async () => {
    const result = await fetchAgentQuestions('http://api.test', {
      fetchImpl: vi.fn(async () => failResponse(401)),
    })
    expect(result).toEqual([])
  })

  it('JSON fora do shape esperado -> lista vazia', async () => {
    const casos = [
      okResponse({ questions: 'não é array' }),
      okResponse({}),
      okResponse(null),
      okResponse('string qualquer'),
      okResponse([1, 2, 3]),
    ]
    for (const resposta of casos) {
      const result = await fetchAgentQuestions('http://api.test', {
        fetchImpl: vi.fn(async () => resposta),
      })
      expect(result).toEqual([])
    }
  })

  it('item individual torto (sem id/text/status) é descartado, o resto da lista sobrevive', async () => {
    const result = await fetchAgentQuestions('http://api.test', {
      fetchImpl: vi.fn(async () =>
        okResponse({
          questions: [
            { id: 'q_ok', text: 'boa', status: 'open', createdAt: '2026-07-21T09:00:00.000Z' },
            { text: 'sem id' },
            null,
            'string solta',
          ],
        })
      ),
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe('q_ok')
  })

  it('options tortas (não-array, ou itens sem label/value) viram [] sem lançar', async () => {
    const result = await fetchAgentQuestions('http://api.test', {
      fetchImpl: vi.fn(async () =>
        okResponse({
          questions: [
            {
              id: 'q_1',
              text: 'x',
              status: 'open',
              createdAt: '2026-07-21T09:00:00.000Z',
              options: 'não é array',
            },
            {
              id: 'q_2',
              text: 'y',
              status: 'open',
              createdAt: '2026-07-21T09:00:00.000Z',
              options: [{ label: 'ok' }, { value: 'sem label' }, { label: 'ok', value: 'v' }],
            },
          ],
        })
      ),
    })
    expect(result.find((q) => q.id === 'q_1')?.options).toEqual([])
    expect(result.find((q) => q.id === 'q_2')?.options).toEqual([{ label: 'ok', value: 'v' }])
  })

  it('res.json() lança (corpo não é JSON válido) -> lista vazia', async () => {
    const result = await fetchAgentQuestions('http://api.test', {
      fetchImpl: vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => {
              throw new Error('corpo inválido')
            },
          }) as unknown as Response
      ),
    })
    expect(result).toEqual([])
  })

  it('rede caída (fetch lança) -> lista vazia, nunca propaga a exceção', async () => {
    const result = await fetchAgentQuestions('http://api.test', {
      fetchImpl: vi.fn(async () => {
        throw new Error('offline')
      }),
    })
    expect(result).toEqual([])
  })
})

describe('sortQuestions — abertas primeiro, depois mais recente primeiro', () => {
  it('põe status "open" antes de qualquer outro status', () => {
    const answered = question({ id: 'a', status: 'answered', createdAt: '2026-07-22T00:00:00Z' })
    const open = question({ id: 'o', status: 'open', createdAt: '2026-01-01T00:00:00Z' })
    expect(sortQuestions([answered, open]).map((q) => q.id)).toEqual(['o', 'a'])
  })

  it('dentro do mesmo status, ordena por createdAt decrescente (mais recente primeiro)', () => {
    const antiga = question({ id: 'antiga', status: 'open', createdAt: '2026-01-01T00:00:00Z' })
    const nova = question({ id: 'nova', status: 'open', createdAt: '2026-07-01T00:00:00Z' })
    expect(sortQuestions([antiga, nova]).map((q) => q.id)).toEqual(['nova', 'antiga'])
  })

  it('não muta o array original', () => {
    const list = [question({ id: 'a', status: 'answered' }), question({ id: 'b', status: 'open' })]
    const original = [...list]
    sortQuestions(list)
    expect(list).toEqual(original)
  })
})

describe('statusLabel — tradução PT-BR', () => {
  it('traduz os 3 status conhecidos', () => {
    expect(statusLabel('open')).toBe('Aguardando resposta')
    expect(statusLabel('answered')).toBe('Respondida')
    expect(statusLabel('expired')).toBe('Expirada')
  })

  it('status desconhecido devolve ele mesmo (nunca inventa um rótulo)', () => {
    expect(statusLabel('seiládeus')).toBe('seiládeus')
  })
})
