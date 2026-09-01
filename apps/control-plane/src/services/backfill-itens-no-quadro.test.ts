import { describe, it, expect } from 'vitest'
import { backfillItensNoQuadro, issueECriadaPeloProduto } from './backfill-itens-no-quadro.js'
import type { IssueParaBackfillDeQuadro } from './backfill-itens-no-quadro.js'

// D12 — "o produto cria a issue e nunca a adiciona ao quadro" também tinha um
// segundo furo: 96 issues abertas hoje (#3611-#3884) já existiam quando o
// board foi apontado certo (D11), e nenhuma delas nasceu DEPOIS do hook de
// board — ADICIONAR daqui pra frente não as alcança. Esta é a passada de
// catch-up, no MESMO padrão de `backfill-peso-existentes.ts` (D8): idempotente
// (item já no quadro não vira duplicata — a MESMA verificação que a idempotência
// de `addToBoard` já garante do lado do GitHub, aqui reforçada do lado da
// decisão de quem tentar), e NUNCA aplica em issue que o produto não tocou —
// "wishlist" (pedido do dono, ainda não virou plano) e "security" (Dependabot)
// ficam de fora por design, não por acidente.

function issue(
  number: number,
  overrides: Partial<IssueParaBackfillDeQuadro> = {}
): IssueParaBackfillDeQuadro {
  return { number, nodeId: `I_${number}`, labels: [], corpo: null, ...overrides }
}

describe('issueECriadaPeloProduto — o critério de quem entra no backfill', () => {
  it('marcador gitorch:node: no corpo conta, mesmo sem etiqueta de agente', () => {
    expect(
      issueECriadaPeloProduto(issue(1, { corpo: '<!-- gitorch:node:42:task:0 -->\n\ntexto' }))
    ).toBe(true)
  })

  it('etiqueta gitorch:agent:* conta, mesmo sem marcador no corpo', () => {
    expect(issueECriadaPeloProduto(issue(2, { labels: ['gitorch:agent:po'] }))).toBe(true)
  })

  it('wishlist pura (pedido do dono, sem plano ainda) fica de fora', () => {
    expect(issueECriadaPeloProduto(issue(3, { labels: ['wishlist'] }))).toBe(false)
  })

  it('alerta de segurança do Dependabot fica de fora', () => {
    expect(
      issueECriadaPeloProduto(issue(4, { labels: ['security', 'dependencies', 'auto-monitor'] }))
    ).toBe(false)
  })

  it('issue sem corpo e sem etiqueta nenhuma fica de fora (nunca um palpite)', () => {
    expect(issueECriadaPeloProduto(issue(5))).toBe(false)
  })
})

describe('backfillItensNoQuadro', () => {
  it('só tenta as candidatas do produto que ainda não estão no quadro', async () => {
    const tentativas: string[] = []
    const resultado = await backfillItensNoQuadro({
      listarIssuesAbertas: async () => [
        issue(10, { corpo: '<!-- gitorch:node:1:task:0 -->' }),
        issue(11, { labels: ['gitorch:agent:po'] }),
        issue(12, { labels: ['wishlist'] }), // fora: não é do produto
        issue(13, { labels: ['security', 'auto-monitor'] }), // fora: não é do produto
      ],
      numerosJaNoQuadro: async () => new Set(),
      adicionarAoQuadro: async (nodeId) => {
        tentativas.push(nodeId)
        return `PVTI_${nodeId}`
      },
    })

    expect(tentativas).toEqual(['I_10', 'I_11'])
    expect(resultado).toEqual({
      totalAbertas: 4,
      candidatas: 2,
      jaNoQuadro: 0,
      adicionadasAgora: 2,
      issuesAdicionadas: [10, 11],
    })
  })

  it('idempotente: candidata já no quadro não vira segunda tentativa', async () => {
    const tentativas: string[] = []
    const resultado = await backfillItensNoQuadro({
      listarIssuesAbertas: async () => [
        issue(20, { corpo: '<!-- gitorch:node:1:task:0 -->' }),
        issue(21, { corpo: '<!-- gitorch:node:1:task:1 -->' }),
      ],
      numerosJaNoQuadro: async () => new Set([20]),
      adicionarAoQuadro: async (nodeId) => {
        tentativas.push(nodeId)
        return `PVTI_${nodeId}`
      },
    })

    expect(tentativas).toEqual(['I_21'])
    expect(resultado.jaNoQuadro).toBe(1)
    expect(resultado.adicionadasAgora).toBe(1)
    expect(resultado.issuesAdicionadas).toEqual([21])
  })

  it('limite opcional corta o tamanho do lote sem esconder quantas ficaram de fora', async () => {
    const tentativas: string[] = []
    const resultado = await backfillItensNoQuadro({
      listarIssuesAbertas: async () => [
        issue(30, { labels: ['gitorch:agent:po'] }),
        issue(31, { labels: ['gitorch:agent:po'] }),
        issue(32, { labels: ['gitorch:agent:po'] }),
      ],
      numerosJaNoQuadro: async () => new Set(),
      adicionarAoQuadro: async (nodeId) => {
        tentativas.push(nodeId)
        return `PVTI_${nodeId}`
      },
      limite: 2,
    })

    expect(tentativas).toEqual(['I_30', 'I_31'])
    expect(resultado.candidatas).toBe(3)
    expect(resultado.adicionadasAgora).toBe(2)
    expect(resultado.issuesAdicionadas).toEqual([30, 31])
  })

  it('sem candidata nenhuma, não chama adicionarAoQuadro', async () => {
    const tentativas: string[] = []
    const resultado = await backfillItensNoQuadro({
      listarIssuesAbertas: async () => [issue(40, { labels: ['wishlist'] })],
      numerosJaNoQuadro: async () => new Set(),
      adicionarAoQuadro: async (nodeId) => {
        tentativas.push(nodeId)
        return `PVTI_${nodeId}`
      },
    })

    expect(tentativas).toEqual([])
    expect(resultado.candidatas).toBe(0)
    expect(resultado.adicionadasAgora).toBe(0)
  })

  it('uma falha de rede no meio SOBE crua — nunca mascara e some com o resto', async () => {
    let chamadas = 0
    await expect(
      backfillItensNoQuadro({
        listarIssuesAbertas: async () => [
          issue(50, { labels: ['gitorch:agent:po'] }),
          issue(51, { labels: ['gitorch:agent:po'] }),
        ],
        numerosJaNoQuadro: async () => new Set(),
        adicionarAoQuadro: async () => {
          chamadas += 1
          if (chamadas === 1) throw new Error('GitHub GraphQL 502')
          return 'PVTI_x'
        },
      })
    ).rejects.toThrow('GitHub GraphQL 502')
  })
})
