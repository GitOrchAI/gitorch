import { describe, it, expect, vi } from 'vitest'
import {
  criarProposta,
  tituloDaPropostaDeAutomacao,
  corpoDaPropostaDeAutomacao,
  marcadorDaProposta,
  LABEL_PROPOSTA,
} from './proposta.js'

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('tituloDaPropostaDeAutomacao', () => {
  it('formata o título exato pedido pelo dono', () => {
    expect(
      tituloDaPropostaDeAutomacao(
        'Auto Merge Checker',
        '.github/workflows/auto-merge-checker.yml',
        '2026-08-20'
      )
    ).toBe(
      'Proposta: workflow "Auto Merge Checker" (.github/workflows/auto-merge-checker.yml) falha desde 2026-08-20 — deletar, reajustar ou manter?'
    )
  })
})

describe('corpoDaPropostaDeAutomacao', () => {
  it('traz Goal, Related Files e a seção de decisão pendente', () => {
    const corpo = corpoDaPropostaDeAutomacao({
      nome: 'Auto Merge Checker',
      arquivo: '.github/workflows/auto-merge-checker.yml',
      gatilho: 'push',
      desde: '2026-08-20',
      resumo: 'dispara em "push"',
    })
    expect(corpo).toContain('## Goal')
    expect(corpo).toContain('## Related Files')
    expect(corpo).toContain('.github/workflows/auto-merge-checker.yml')
    expect(corpo).toContain('## Decisão do dono: pendente')
    expect(corpo).not.toContain(marcadorDaProposta('qualquer'))
  })
})

describe('criarProposta', () => {
  function fetchQueCria(overrides: Partial<{ criarStatus: number; labelStatus: number }> = {}) {
    const chamadas: Array<{ url: string; method: string; body?: string | undefined }> = []
    const impl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      chamadas.push({ url: u, method, body: init?.body as string | undefined })
      if (method === 'GET' && u.includes('/issues?labels=')) {
        return jsonResp([]) // nenhuma proposta existente
      }
      if (method === 'POST' && u.endsWith('/labels')) {
        return jsonResp({}, overrides.labelStatus ?? 201)
      }
      if (method === 'POST' && u.endsWith('/issues')) {
        return jsonResp({ number: 555, node_id: 'ISSUE_NODE_555' }, overrides.criarStatus ?? 201)
      }
      throw new Error(`fetch inesperado: ${method} ${u}`)
    }) as typeof fetch
    return { impl, chamadas }
  }

  it('cria a issue com marcador + label gitorch:proposal, garante a label antes, e anexa ao quadro', async () => {
    const { impl, chamadas } = fetchQueCria()
    const anexarAoQuadro = vi.fn(async () => undefined)
    const numero = await criarProposta(
      {
        repo: 'acme/api',
        identidade: 'wf:77',
        titulo:
          'Proposta: workflow "X" (.github/workflows/x.yml) falha desde 2026-08-20 — deletar, reajustar ou manter?',
        corpo:
          '## Goal\n\nO workflow "X" está falhando.\n\n## Related Files\n\n- .github/workflows/x.yml',
        origem: 'incidente-automacao',
      },
      { fetchImpl: impl, token: 'tok', anexarAoQuadro }
    )

    expect(numero).toBe(555)

    const buscaChamada = chamadas.find((c) => c.method === 'GET')
    expect(buscaChamada?.url).toContain('labels=gitorch%3Aproposal')
    expect(buscaChamada?.url).toContain('state=open')

    const labelChamada = chamadas.find((c) => c.method === 'POST' && c.url.endsWith('/labels'))
    expect(labelChamada).toBeDefined()
    const labelBody = JSON.parse(labelChamada!.body!)
    expect(labelBody.name).toBe(LABEL_PROPOSTA)
    expect(labelBody.description).toMatch(/proposta|decisão/i)

    const criaChamada = chamadas.find((c) => c.method === 'POST' && c.url.endsWith('/issues'))
    expect(criaChamada).toBeDefined()
    const criaBody = JSON.parse(criaChamada!.body!)
    expect(criaBody.labels).toEqual([LABEL_PROPOSTA])
    expect(criaBody.body).toContain(marcadorDaProposta('wf:77'))
    // NUNCA label jules nem P0 numa proposta.
    expect(criaBody.labels).not.toContain('jules')
    expect(JSON.stringify(criaBody)).not.toMatch(/\bP[0-3]\b/)

    expect(anexarAoQuadro).toHaveBeenCalledWith({ issueNodeId: 'ISSUE_NODE_555', issueNumber: 555 })
  })

  it('label já existe (422) não é erro — segue e cria a issue', async () => {
    const { impl } = fetchQueCria({ labelStatus: 422 })
    const numero = await criarProposta(
      {
        repo: 'acme/api',
        identidade: 'wf:78',
        titulo: 't',
        corpo: 'c',
        origem: 'incidente-automacao',
      },
      { fetchImpl: impl, token: 'tok' }
    )
    expect(numero).toBe(555)
  })

  it('idempotente: já existe issue aberta com o marcador → devolve o número existente, NÃO cria de novo', async () => {
    const chamadas: string[] = []
    const impl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const u = String(url)
      chamadas.push(`${init?.method ?? 'GET'} ${u}`)
      if (u.includes('/issues?labels=')) {
        return jsonResp([
          {
            number: 900,
            body: `<!-- ${marcadorDaProposta('wf:79')} -->\n\ncorpo antigo`,
            node_id: 'X',
          },
        ])
      }
      throw new Error(`fetch inesperado nao deveria acontecer: ${u}`)
    }) as typeof fetch

    const numero = await criarProposta(
      {
        repo: 'acme/api',
        identidade: 'wf:79',
        titulo: 't',
        corpo: 'c',
        origem: 'incidente-automacao',
      },
      { fetchImpl: impl, token: 'tok' }
    )
    expect(numero).toBe(900)
    expect(chamadas.some((c) => c.startsWith('POST'))).toBe(false)
  })

  it('projeto em so_olhar (fetch guardado recusa) → propaga o erro, NUNCA engole', async () => {
    class RecusaFake extends Error {}
    const impl = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET') return jsonResp([])
      throw new RecusaFake('Não posso propor trabalho: você me deixou em "Só olhar"')
    }) as typeof fetch

    await expect(
      criarProposta(
        {
          repo: 'acme/api',
          identidade: 'wf:80',
          titulo: 't',
          corpo: 'c',
          origem: 'incidente-automacao',
        },
        { fetchImpl: impl, token: 'tok' }
      )
    ).rejects.toThrow(/Só olhar/)
  })
})
