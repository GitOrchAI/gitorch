import { describe, it, expect, vi } from 'vitest'
import {
  formatarAvisoDeCustoDaOrdem,
  dedupKeyDeCustoDaOrdem,
  parseDedupKeyDeCustoDaOrdem,
  perguntarSobreCustoDaOrdem,
  processarRespostaDeCustoDaOrdem,
  textoDaFilaAtual,
  OPCOES_DE_CUSTO_DA_ORDEM,
  VALOR_APLICAR_TROCA,
  VALOR_MANTER_ORDEM,
  VALOR_VER_FILA,
  PERIODO_DE_SILENCIO_APOS_MANTER_MS,
} from './aviso-de-custo-da-ordem.js'
import { FREE_TEXT_OPTION_VALUE } from './telegram-bot.js'
import type { CandidatoDeTroca, PedidoNaFila } from '@gitorch/cadence'

const CANDIDATO: CandidatoDeTroca = {
  pedido: 102,
  peso: 1,
  esperaAtual: 13,
  esperaOtima: 0,
  perda: 13,
  razao: 13,
}

describe('formatarAvisoDeCustoDaOrdem — a frase do losango, com o número', () => {
  it('cita o pedido e o número da antecipação — nunca "considere reordenar" genérico', () => {
    const texto = formatarAvisoDeCustoDaOrdem(CANDIDATO)
    expect(texto).toContain('#102')
    expect(texto).toContain('13')
    expect(texto).toContain('Quer trocar?')
  })

  it('deixa claro que a ordem do dono continua valendo até ele decidir', () => {
    // A lei do desenho: "você sempre decide". O texto não pode soar como se
    // o produto já tivesse trocado, nem pedir uma ação obrigatória.
    const texto = formatarAvisoDeCustoDaOrdem(CANDIDATO)
    expect(texto.toLowerCase()).toContain('continua valendo')
  })

  it('não fala em "sprints" — o produto não mede velocidade/capacidade por sprint', () => {
    // Decisão registrada em custo-da-ordem.ts: converter para "sprints"
    // fabricaria um número que o produto não sustenta com dado real.
    const texto = formatarAvisoDeCustoDaOrdem(CANDIDATO)
    expect(texto.toLowerCase()).not.toContain('sprint')
  })

  it('pluraliza "ponto" corretamente para perda de 1', () => {
    const texto = formatarAvisoDeCustoDaOrdem({ ...CANDIDATO, perda: 1 })
    expect(texto).toContain('1 ponto de peso')
    expect(texto).not.toContain('1 pontos')
  })

  it('usa plural para perda maior que 1', () => {
    const texto = formatarAvisoDeCustoDaOrdem(CANDIDATO)
    expect(texto).toContain('13 pontos de peso')
  })
})

// L4-T18, item 1 — o aviso vira PERGUNTA FORMAL (D71): dedupKey por
// repositório+pedido, 3 opções objetivas + o botão de escrever. NUNCA mexe
// no critério que decide se a ordem custa caro (analisarCustoDaOrdem,
// packages/cadence) — só na forma de perguntar.

describe('dedupKeyDeCustoDaOrdem — chave por repositório e pedido', () => {
  it('monta "custo-da-ordem:<repo>:<pedido>" na primeira rodada', () => {
    expect(dedupKeyDeCustoDaOrdem('acme/api', 102)).toBe('custo-da-ordem:acme/api:102')
  })

  it('rodada > 1 (reabertura depois do período de silêncio de "manter") anexa a rodada', () => {
    expect(dedupKeyDeCustoDaOrdem('acme/api', 102, 2)).toBe('custo-da-ordem:acme/api:102:2')
  })

  it('recusa repo que não parece "dono/nome"', () => {
    expect(() => dedupKeyDeCustoDaOrdem('acme', 102)).toThrow(/repo/i)
  })

  it('recusa pedido não inteiro positivo', () => {
    expect(() => dedupKeyDeCustoDaOrdem('acme/api', 0)).toThrow(/pedido/i)
    expect(() => dedupKeyDeCustoDaOrdem('acme/api', 1.5)).toThrow(/pedido/i)
  })
})

describe('parseDedupKeyDeCustoDaOrdem — lê a chave de volta', () => {
  it('formato simples (rodada implícita 1)', () => {
    expect(parseDedupKeyDeCustoDaOrdem('custo-da-ordem:acme/api:102')).toEqual({
      repo: 'acme/api',
      pedido: 102,
      rodada: 1,
    })
  })

  it('formato com rodada explícita', () => {
    expect(parseDedupKeyDeCustoDaOrdem('custo-da-ordem:acme/api:102:3')).toEqual({
      repo: 'acme/api',
      pedido: 102,
      rodada: 3,
    })
  })

  it('prefixo errado devolve null, nunca lança', () => {
    expect(parseDedupKeyDeCustoDaOrdem('automacao:acme/api:wf:1')).toBeNull()
  })

  it('formato quebrado devolve null', () => {
    expect(parseDedupKeyDeCustoDaOrdem('custo-da-ordem:acme/api')).toBeNull()
    expect(parseDedupKeyDeCustoDaOrdem('custo-da-ordem:acme/api:abc')).toBeNull()
  })
})

describe('OPCOES_DE_CUSTO_DA_ORDEM — as 3 opções objetivas (D71)', () => {
  it('são exatamente aplicar / manter / ver a fila, nesta ordem', () => {
    expect(OPCOES_DE_CUSTO_DA_ORDEM).toEqual([
      { label: 'Aplicar a troca sugerida', value: VALOR_APLICAR_TROCA },
      { label: 'Manter minha ordem', value: VALOR_MANTER_ORDEM },
      { label: 'Ver a fila antes de decidir', value: VALOR_VER_FILA },
    ])
  })
})

describe('perguntarSobreCustoDaOrdem — ask() com dedupKey + 3 opções + escrever', () => {
  it('chama ask() com o texto do losango, as 3 opções + o botão de escrever, e o dedupKey certo', async () => {
    const ask = vi.fn().mockResolvedValue({ deduped: false, question: {} })

    await perguntarSobreCustoDaOrdem(
      { userId: 'user-1', projectId: 'proj-1', repo: 'acme/api', candidato: CANDIDATO },
      { agentQuestion: { ask } }
    )

    expect(ask).toHaveBeenCalledOnce()
    const [userId, projectId, input] = ask.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ]
    expect(userId).toBe('user-1')
    expect(projectId).toBe('proj-1')
    expect(input['text']).toBe(formatarAvisoDeCustoDaOrdem(CANDIDATO))
    expect(input['options']).toEqual([
      ...OPCOES_DE_CUSTO_DA_ORDEM,
      expect.objectContaining({ value: FREE_TEXT_OPTION_VALUE }),
    ])
    expect(input['dedupKey']).toBe('custo-da-ordem:acme/api:102')
  })

  it('rodada > 1 vai para o dedupKey (reabertura depois do silêncio de "manter")', async () => {
    const ask = vi.fn().mockResolvedValue({ deduped: false, question: {} })
    await perguntarSobreCustoDaOrdem(
      { userId: 'user-1', projectId: 'proj-1', repo: 'acme/api', candidato: CANDIDATO, rodada: 2 },
      { agentQuestion: { ask } }
    )
    const input = ask.mock.calls[0]![2] as Record<string, unknown>
    expect(input['dedupKey']).toBe('custo-da-ordem:acme/api:102:2')
  })
})

// L4-T18, item 2 — a resposta faz alguma coisa DE VERDADE. Manipulador puro
// (sem I/O de rede aqui — quem chama injeta os efeitos, mesmo padrão de
// `processarRespostaDeAutomacao`, decisao-de-automacao.ts).

const FILA: PedidoNaFila[] = [
  { pedido: 101, peso: 13 },
  { pedido: 102, peso: 1 },
  { pedido: 103, peso: 2 },
]
const FILA_COM_ID = [
  { pedido: 101, peso: 13, itemId: 'item-101' },
  { pedido: 102, peso: 1, itemId: 'item-102' },
  { pedido: 103, peso: 2, itemId: 'item-103' },
]

function depsDaResposta(over: Partial<Parameters<typeof processarRespostaDeCustoDaOrdem>[1]> = {}) {
  return {
    filaAtual: vi.fn().mockResolvedValue(FILA_COM_ID),
    aplicarOrdem: vi.fn().mockResolvedValue(undefined),
    silenciarCandidato: vi.fn().mockResolvedValue(undefined),
    limparEstadoAposAplicar: vi.fn().mockResolvedValue(undefined),
    agora: () => new Date('2026-09-04T12:00:00.000Z'),
    ...over,
  }
}

describe('processarRespostaDeCustoDaOrdem — "aplicar": reordena pelo caminho que já existe', () => {
  it('lê a fila fresca, calcula a ordem que minimiza espera (SPT) e aplica via itemId', async () => {
    const deps = depsDaResposta()

    await processarRespostaDeCustoDaOrdem(
      { dedupKey: 'custo-da-ordem:acme/api:102', resposta: VALOR_APLICAR_TROCA },
      deps
    )

    expect(deps.filaAtual).toHaveBeenCalledOnce()
    expect(deps.aplicarOrdem).toHaveBeenCalledOnce()
    // SPT de [13,1,2] por peso crescente: #102 (1), #103 (2), #101 (13).
    expect((deps.aplicarOrdem as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toEqual([
      { pedido: 102, itemId: 'item-102' },
      { pedido: 103, itemId: 'item-103' },
      { pedido: 101, itemId: 'item-101' },
    ])
  })

  it('aplicou de verdade: limpa o estado (o próximo candidato, se houver, é NOVO)', async () => {
    const deps = depsDaResposta()
    await processarRespostaDeCustoDaOrdem(
      { dedupKey: 'custo-da-ordem:acme/api:102', resposta: VALOR_APLICAR_TROCA },
      deps
    )
    expect(deps.limparEstadoAposAplicar).toHaveBeenCalledOnce()
  })

  it('sem fila legível: nada de reordenar, devolve aviso claro, NUNCA lança', async () => {
    const deps = depsDaResposta({ filaAtual: vi.fn().mockResolvedValue(null) })
    const resultado = await processarRespostaDeCustoDaOrdem(
      { dedupKey: 'custo-da-ordem:acme/api:102', resposta: VALOR_APLICAR_TROCA },
      deps
    )
    expect(deps.aplicarOrdem).not.toHaveBeenCalled()
    expect(resultado?.aviso).toBeTruthy()
  })
})

describe('processarRespostaDeCustoDaOrdem — "manter": registra e silencia por um período', () => {
  it('silencia ESTE pedido até agora + o período configurado', async () => {
    const deps = depsDaResposta()
    await processarRespostaDeCustoDaOrdem(
      { dedupKey: 'custo-da-ordem:acme/api:102', resposta: VALOR_MANTER_ORDEM },
      deps
    )
    expect(deps.silenciarCandidato).toHaveBeenCalledWith({
      pedido: 102,
      ate: new Date(deps.agora().getTime() + PERIODO_DE_SILENCIO_APOS_MANTER_MS),
    })
  })

  it('não mexe no quadro nem reordena nada', async () => {
    const deps = depsDaResposta()
    await processarRespostaDeCustoDaOrdem(
      { dedupKey: 'custo-da-ordem:acme/api:102', resposta: VALOR_MANTER_ORDEM },
      deps
    )
    expect(deps.aplicarOrdem).not.toHaveBeenCalled()
  })
})

describe('processarRespostaDeCustoDaOrdem — "ver a fila": informa e mantém a decisão em aberto', () => {
  it('devolve a fila atual em texto, na ordem, com o peso de cada item', async () => {
    const deps = depsDaResposta()
    const resultado = await processarRespostaDeCustoDaOrdem(
      { dedupKey: 'custo-da-ordem:acme/api:102', resposta: VALOR_VER_FILA },
      deps
    )
    expect(resultado?.aviso).toContain('#101')
    expect(resultado?.aviso).toContain('#102')
    expect(resultado?.aviso).toContain('#103')
    expect(resultado?.aviso).toContain('peso 13')
  })

  it('NÃO reordena e NÃO silencia — a decisão de verdade (aplicar/manter) segue em aberto', async () => {
    const deps = depsDaResposta()
    await processarRespostaDeCustoDaOrdem(
      { dedupKey: 'custo-da-ordem:acme/api:102', resposta: VALOR_VER_FILA },
      deps
    )
    expect(deps.aplicarOrdem).not.toHaveBeenCalled()
    expect(deps.silenciarCandidato).not.toHaveBeenCalled()
  })
})

describe('processarRespostaDeCustoDaOrdem — resposta livre ou dedupKey estranho: nunca lança', () => {
  it('resposta livre (texto do "Vou escrever"): só registra, sem ação automática', async () => {
    const deps = depsDaResposta()
    const resultado = await processarRespostaDeCustoDaOrdem(
      { dedupKey: 'custo-da-ordem:acme/api:102', resposta: 'prefiro esperar a sprint acabar' },
      deps
    )
    expect(deps.aplicarOrdem).not.toHaveBeenCalled()
    expect(deps.silenciarCandidato).not.toHaveBeenCalled()
    expect(resultado).toBeUndefined()
  })

  it('dedupKey de outro prefixo: no-op (nunca deveria ter sido roteado aqui)', async () => {
    const deps = depsDaResposta()
    const resultado = await processarRespostaDeCustoDaOrdem(
      { dedupKey: 'automacao:acme/api:wf:1', resposta: VALOR_APLICAR_TROCA },
      deps
    )
    expect(deps.aplicarOrdem).not.toHaveBeenCalled()
    expect(resultado).toBeUndefined()
  })
})

describe('textoDaFilaAtual — a fila em texto para o dono ler', () => {
  it('numera os pedidos na ordem, com o peso de cada um', () => {
    const texto = textoDaFilaAtual(FILA)
    expect(texto).toContain('1. #101 (peso 13)')
    expect(texto).toContain('2. #102 (peso 1)')
    expect(texto).toContain('3. #103 (peso 2)')
  })

  it('fila vazia: diz isso, sem lançar', () => {
    expect(textoDaFilaAtual([])).toMatch(/vazia/i)
  })
})
