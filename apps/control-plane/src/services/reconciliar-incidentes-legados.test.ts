import { describe, it, expect, vi } from 'vitest'
import {
  identidadeDoMarcador,
  reconciliarIncidentesLegados,
} from './reconciliar-incidentes-legados.js'

describe('identidadeDoMarcador', () => {
  it('extrai a identidade do marcador HTML no corpo da issue', () => {
    expect(identidadeDoMarcador('texto\n<!-- gitorch:incident:wf:11 -->\nmais texto')).toBe('wf:11')
  })

  it('extrai identidade legada (ci:<nome>, com travessão e espaços)', () => {
    expect(
      identidadeDoMarcador('<!--gitorch:incident:ci:Jules API Retry — re-dispara via API direta-->')
    ).toBe('ci:Jules API Retry — re-dispara via API direta')
  })

  it('sem marcador → null', () => {
    expect(identidadeDoMarcador('issue comum, sem marcador nenhum')).toBeNull()
  })

  it('body vazio/ausente → null, nunca explode', () => {
    expect(identidadeDoMarcador(null)).toBeNull()
    expect(identidadeDoMarcador(undefined)).toBeNull()
    expect(identidadeDoMarcador('')).toBeNull()
  })
})

describe('reconciliarIncidentesLegados', () => {
  function issue(over: Partial<{ number: number; body: string | null; createdAt: Date }> = {}) {
    return {
      number: 25,
      body: '<!-- gitorch:incident:wf:11 -->',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      ...over,
    }
  }

  it('issue com marcador e sem linha ainda → cria o incidente com firstSeenAt=createdAt e o PR da sessão', async () => {
    const criarIncidente = vi.fn(async () => undefined)
    const deps = {
      projectId: 'p1',
      listarIssuesAbertas: vi.fn(async () => [issue()]),
      jaExisteLinha: vi.fn(async () => false),
      prDaSessaoDaIssue: vi.fn(async () => 90),
      criarIncidente,
    }

    const r = await reconciliarIncidentesLegados(deps)

    expect(criarIncidente).toHaveBeenCalledWith({
      projectId: 'p1',
      identidadeEstavel: 'wf:11',
      classe: 'ci-do-cliente',
      issueNumber: 25,
      firstSeenAt: issue().createdAt,
      prNumber: 90,
    })
    expect(r.reconciliados).toEqual(['wf:11'])
  })

  it('issue sem marcador → ignora, nunca chama criarIncidente', async () => {
    const criarIncidente = vi.fn(async () => undefined)
    const deps = {
      projectId: 'p1',
      listarIssuesAbertas: vi.fn(async () => [issue({ body: 'sem marcador nenhum' })]),
      jaExisteLinha: vi.fn(async () => false),
      prDaSessaoDaIssue: vi.fn(async () => null),
      criarIncidente,
    }

    const r = await reconciliarIncidentesLegados(deps)

    expect(criarIncidente).not.toHaveBeenCalled()
    expect(r.ignorados).toBe(1)
    expect(r.reconciliados).toEqual([])
  })

  it('já existe linha para essa identidade → idempotente, não recria', async () => {
    const criarIncidente = vi.fn(async () => undefined)
    const jaExisteLinha = vi.fn(async () => true)
    const deps = {
      projectId: 'p1',
      listarIssuesAbertas: vi.fn(async () => [issue()]),
      jaExisteLinha,
      prDaSessaoDaIssue: vi.fn(async () => null),
      criarIncidente,
    }

    const r = await reconciliarIncidentesLegados(deps)

    expect(jaExisteLinha).toHaveBeenCalledWith({ projectId: 'p1', identidadeEstavel: 'wf:11' })
    expect(criarIncidente).not.toHaveBeenCalled()
    expect(r.ignorados).toBe(1)
  })

  it('sessão ainda sem PR → cria o incidente com prNumber null (não trava a reconciliação)', async () => {
    const criarIncidente = vi.fn(async () => undefined)
    const deps = {
      projectId: 'p1',
      listarIssuesAbertas: vi.fn(async () => [issue()]),
      jaExisteLinha: vi.fn(async () => false),
      prDaSessaoDaIssue: vi.fn(async () => null),
      criarIncidente,
    }

    await reconciliarIncidentesLegados(deps)

    expect(criarIncidente).toHaveBeenCalledWith(expect.objectContaining({ prNumber: null }))
  })

  it('uma issue que falha no meio não derruba as outras', async () => {
    const criarIncidente = vi.fn(async () => undefined)
    const deps = {
      projectId: 'p1',
      listarIssuesAbertas: vi.fn(async () => [
        issue({ number: 1 }),
        issue({ number: 2, body: '<!-- gitorch:incident:wf:22 -->' }),
      ]),
      jaExisteLinha: vi.fn(async () => false),
      prDaSessaoDaIssue: vi.fn(async (n: number) => {
        if (n === 1) throw new Error('boom')
        return null
      }),
      criarIncidente,
    }

    const r = await reconciliarIncidentesLegados(deps)

    expect(criarIncidente).toHaveBeenCalledTimes(1)
    expect(r.reconciliados).toEqual(['wf:22'])
  })

  it('listarIssuesAbertas falha → não derruba a varredura, devolve vazio', async () => {
    const criarIncidente = vi.fn(async () => undefined)
    const deps = {
      projectId: 'p1',
      listarIssuesAbertas: vi.fn(async () => {
        throw new Error('rede fora')
      }),
      jaExisteLinha: vi.fn(async () => false),
      prDaSessaoDaIssue: vi.fn(async () => null),
      criarIncidente,
    }

    const r = await reconciliarIncidentesLegados(deps)

    expect(r).toEqual({ reconciliados: [], ignorados: 0 })
    expect(criarIncidente).not.toHaveBeenCalled()
  })
})
