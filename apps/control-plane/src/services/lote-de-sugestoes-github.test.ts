import { describe, it, expect, vi } from 'vitest'
import { listarIssuesAbertasReal, fecharIssueReal } from './lote-de-sugestoes-github.js'

function respostaJson(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response
}

describe('listarIssuesAbertasReal — nunca só as 100 primeiras em silêncio', () => {
  it('uma página só, menor que 100: para sem pedir a próxima', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      respostaJson([
        {
          number: 1,
          title: 'a',
          body: 'x',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          labels: [],
        },
      ])
    )
    const issues = await listarIssuesAbertasReal('dono/repo', 'tok', { fetchImpl })
    expect(issues).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('pagina até a última página ficar vazia', async () => {
    const pagina1 = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      title: 't',
      body: '',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      labels: [],
    }))
    const pagina2 = [
      {
        number: 101,
        title: 't',
        body: '',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        labels: [],
      },
    ]
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(respostaJson(pagina1))
      .mockResolvedValueOnce(respostaJson(pagina2))
    const issues = await listarIssuesAbertasReal('dono/repo', 'tok', { fetchImpl })
    expect(issues).toHaveLength(101)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('descarta pull requests — a API de issues do GitHub inclui os dois', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      respostaJson([
        {
          number: 1,
          title: 'issue de verdade',
          body: '',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          labels: [],
        },
        {
          number: 2,
          title: 'na verdade é um PR',
          body: '',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          labels: [],
          pull_request: { url: 'x' },
        },
      ])
    )
    const issues = await listarIssuesAbertasReal('dono/repo', 'tok', { fetchImpl })
    expect(issues.map((i) => i.number)).toEqual([1])
  })

  it('labels chegam como objeto ou string — normaliza para string', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      respostaJson([
        {
          number: 1,
          title: 't',
          body: '',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          labels: [{ name: 'bug' }, 'urgent'],
        },
      ])
    )
    const issues = await listarIssuesAbertasReal('dono/repo', 'tok', { fetchImpl })
    expect(issues[0]?.labels).toEqual(['bug', 'urgent'])
  })

  it('HTTP não-ok lança com o status — nunca devolve lista vazia fingindo sucesso', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respostaJson({ message: 'bad' }, false, 502))
    await expect(listarIssuesAbertasReal('dono/repo', 'tok', { fetchImpl })).rejects.toThrow('502')
  })

  it('respeita o teto de páginas — não roda para sempre', async () => {
    const pagina = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      title: 't',
      body: '',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      labels: [],
    }))
    const fetchImpl = vi.fn().mockResolvedValue(respostaJson(pagina))
    const issues = await listarIssuesAbertasReal('dono/repo', 'tok', {
      fetchImpl,
      maxPaginas: 2,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(issues).toHaveLength(200)
  })
})

describe('fecharIssueReal — PATCH state:closed + comentário, mesma forma do scheduler', () => {
  it('fecha e comenta, nesta ordem', async () => {
    const chamadas: string[] = []
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      chamadas.push(`${init?.method} ${url}`)
      return respostaJson({})
    })
    await fecharIssueReal('dono/repo', 42, 'motivo', 'tok', fetchImpl as unknown as typeof fetch)
    expect(chamadas).toEqual([
      'PATCH https://api.github.com/repos/dono/repo/issues/42',
      'POST https://api.github.com/repos/dono/repo/issues/42/comments',
    ])
  })

  it('PATCH que falha lança — a issue NÃO foi fechada de verdade', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respostaJson({}, false, 403))
    await expect(
      fecharIssueReal('dono/repo', 42, 'motivo', 'tok', fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow('403')
  })

  it('comentário que falha NÃO lança — o fechamento já aconteceu, best-effort', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(respostaJson({}, true, 200))
      .mockResolvedValueOnce(respostaJson({}, false, 500))
    await expect(
      fecharIssueReal('dono/repo', 42, 'motivo', 'tok', fetchImpl as unknown as typeof fetch)
    ).resolves.toBeUndefined()
  })
})
