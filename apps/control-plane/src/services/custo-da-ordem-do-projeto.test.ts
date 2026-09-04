import { describe, it, expect, vi } from 'vitest'
import {
  avaliarCustoDaOrdemDosProjetos,
  type DepsDeCustoDaOrdem,
  type ProjetoParaAvaliar,
  type EstadoDoAvisoDeCustoDaOrdem,
} from './custo-da-ordem-do-projeto.js'
import type { PedidoNaFila } from '@gitorch/cadence'

// A CAIXA DO DESENHO, ligada ao ciclo: lê a fila do quadro (ordem + peso, o
// que já existe), calcula, e — quando custa caro de verdade — PERGUNTA ao
// dono, formalmente (D71/L4-T18), com o pedido e o número. NUNCA reordena:
// repare que `DepsDeCustoDaOrdem` não tem NENHUMA função de escrita no
// quadro. Não é omissão de teste, é a arquitetura: esta função
// estruturalmente NÃO TEM COMO tocar a ordem do cliente, porque a
// capacidade de mover item nem chega até aqui — quem reordena é
// `processarRespostaDeCustoDaOrdem` (aviso-de-custo-da-ordem.ts), DEPOIS que
// o dono escolher "aplicar".

const P1: ProjetoParaAvaliar = { id: 'proj_1', wingId: 'acme/api' }
const P2: ProjetoParaAvaliar = { id: 'proj_2', wingId: 'acme/web' }

const FILA_CARA: PedidoNaFila[] = [
  { pedido: 101, peso: 13 },
  { pedido: 102, peso: 1 },
  { pedido: 103, peso: 2 },
]

const ESTADO_LIMPO: EstadoDoAvisoDeCustoDaOrdem = { ultimoPedidoProposto: null, silencio: null }

function deps(over: Partial<DepsDeCustoDaOrdem> = {}): DepsDeCustoDaOrdem {
  return {
    projetos: async () => [P1],
    filaDoQuadro: async () => FILA_CARA,
    lerEstado: async () => ESTADO_LIMPO,
    salvarEstado: vi.fn().mockResolvedValue(undefined),
    avisar: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

describe('avaliarCustoDaOrdemDosProjetos — sem projeto nenhum', () => {
  it('não quebra e devolve resumo zerado', async () => {
    const d = deps({ projetos: async () => [] })
    const resumo = await avaliarCustoDaOrdemDosProjetos(d)
    expect(resumo).toEqual({ avaliados: 0, avisados: 0 })
    expect(d.avisar).not.toHaveBeenCalled()
  })
})

describe('avaliarCustoDaOrdemDosProjetos — a pergunta chega com o candidato certo (a PROVA da caixa)', () => {
  it('ordem cara pela primeira vez: pergunta ao dono, com o projeto, o candidato e a rodada 1', async () => {
    const d = deps()
    const resumo = await avaliarCustoDaOrdemDosProjetos(d)

    expect(resumo).toEqual({ avaliados: 1, avisados: 1 })
    expect(d.avisar).toHaveBeenCalledTimes(1)
    const [projetoAvisado, candidato, rodada] = (d.avisar as ReturnType<typeof vi.fn>).mock
      .calls[0]!
    expect(projetoAvisado).toBe(P1)
    expect(candidato).toMatchObject({ pedido: 102, perda: 13 })
    expect(rodada).toBe(1)
  })

  it('grava o pedido proposto no estado, para não repetir a mesma pergunta', async () => {
    const d = deps()
    await avaliarCustoDaOrdemDosProjetos(d)
    expect(d.salvarEstado).toHaveBeenCalledWith(P1.id, {
      ultimoPedidoProposto: 102,
      silencio: null,
    })
  })
})

describe('avaliarCustoDaOrdemDosProjetos — a ordem do dono SEMPRE prevalece', () => {
  it('se ele não responder, nada muda: rodar de novo com o MESMO candidato não repete a pergunta', async () => {
    // Simula duas passadas do relógio. Na primeira, pergunta e grava. Na
    // segunda — o dono não respondeu, a fila do quadro está EXATAMENTE
    // igual — o mesmo candidato não pode virar uma segunda pergunta: seria a
    // rajada de mensagens de rotina que o dono já reclamou (29/08).
    let estadoGravado: EstadoDoAvisoDeCustoDaOrdem = ESTADO_LIMPO
    const d = deps({
      salvarEstado: vi.fn(async (_id, estado) => {
        estadoGravado = estado
      }),
      lerEstado: vi.fn(async () => estadoGravado),
    })

    const primeira = await avaliarCustoDaOrdemDosProjetos(d)
    expect(primeira.avisados).toBe(1)

    const segunda = await avaliarCustoDaOrdemDosProjetos(d)
    expect(segunda.avisados).toBe(0)
    expect(d.avisar).toHaveBeenCalledTimes(1)

    // E o mais importante: em NENHUM momento a fila mudou de ordem sozinha.
    // A única fonte de "fila" nestes deps é `filaDoQuadro`, fixa em
    // FILA_CARA nas duas passadas — o produto nunca escreveu nada nela.
  })

  it('candidato MUDOU (fila diferente): pergunta de novo, mesmo já tendo perguntado antes', async () => {
    // A fila do quadro já mudou (o dono mexeu, ou o PO planejou algo novo)
    // desde a última passada, que tinha proposto #102. Este candidato é
    // outro — #203 — e merece uma pergunta nova, mesmo com uma marca antiga.
    const OUTRA_FILA_CARA: PedidoNaFila[] = [
      { pedido: 201, peso: 8 },
      { pedido: 202, peso: 13 },
      { pedido: 203, peso: 1 },
    ]
    const d = deps({
      filaDoQuadro: async () => OUTRA_FILA_CARA,
      lerEstado: vi.fn(async () => ({ ultimoPedidoProposto: 102, silencio: null })), // já perguntou #102 antes
    })

    const resumo = await avaliarCustoDaOrdemDosProjetos(d)
    expect(resumo.avisados).toBe(1)
    const [, candidato] = (d.avisar as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(candidato).toMatchObject({ pedido: 203 })
  })

  it('a ordem deixou de custar caro: limpa a marca (silêncio, sem nova pergunta)', async () => {
    const FILA_JA_OTIMA: PedidoNaFila[] = [
      { pedido: 1, peso: 1 },
      { pedido: 2, peso: 3 },
      { pedido: 3, peso: 8 },
    ]
    const d = deps({
      filaDoQuadro: async () => FILA_JA_OTIMA,
      lerEstado: async () => ({ ultimoPedidoProposto: 102, silencio: null }),
    })
    const resumo = await avaliarCustoDaOrdemDosProjetos(d)
    expect(resumo.avisados).toBe(0)
    expect(d.avisar).not.toHaveBeenCalled()
    expect(d.salvarEstado).toHaveBeenCalledWith(P1.id, {
      ultimoPedidoProposto: null,
      silencio: null,
    })
  })
})

describe('avaliarCustoDaOrdemDosProjetos — L4-T18: "manter" silencia por um período, nunca para sempre', () => {
  it('candidato ainda dentro do silêncio: não pergunta de novo', async () => {
    const d = deps({
      lerEstado: async () => ({
        ultimoPedidoProposto: 102,
        silencio: { pedido: 102, ate: '2026-09-05T00:00:00.000Z', rodada: 1 },
      }),
      agora: () => new Date('2026-09-04T12:00:00.000Z'), // antes do "ate"
    })
    const resumo = await avaliarCustoDaOrdemDosProjetos(d)
    expect(resumo.avisados).toBe(0)
    expect(d.avisar).not.toHaveBeenCalled()
  })

  it('silêncio já venceu e o MESMO candidato continua o pior: pergunta de novo, na PRÓXIMA rodada', async () => {
    const d = deps({
      lerEstado: async () => ({
        ultimoPedidoProposto: 102,
        silencio: { pedido: 102, ate: '2026-09-05T00:00:00.000Z', rodada: 1 },
      }),
      agora: () => new Date('2026-09-06T00:00:00.000Z'), // depois do "ate"
    })
    const resumo = await avaliarCustoDaOrdemDosProjetos(d)
    expect(resumo.avisados).toBe(1)
    const [, candidato, rodada] = (d.avisar as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(candidato).toMatchObject({ pedido: 102 })
    expect(rodada).toBe(2)
  })

  it('silêncio de OUTRO pedido não afasta a pergunta sobre o candidato atual', async () => {
    const d = deps({
      lerEstado: async () => ({
        ultimoPedidoProposto: 999,
        silencio: { pedido: 999, ate: '2099-01-01T00:00:00.000Z', rodada: 1 },
      }),
    })
    const resumo = await avaliarCustoDaOrdemDosProjetos(d)
    expect(resumo.avisados).toBe(1)
    const [, candidato, rodada] = (d.avisar as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(candidato).toMatchObject({ pedido: 102 })
    expect(rodada).toBe(1)
  })
})

describe('avaliarCustoDaOrdemDosProjetos — leitura indisponível é silêncio, não erro', () => {
  it('fila null (sem quadro, sem credencial, sem campo Peso): pula o projeto sem perguntar', async () => {
    const d = deps({ filaDoQuadro: async () => null })
    const resumo = await avaliarCustoDaOrdemDosProjetos(d)
    expect(resumo).toEqual({ avaliados: 1, avisados: 0 })
    expect(d.avisar).not.toHaveBeenCalled()
    expect(d.salvarEstado).not.toHaveBeenCalled()
  })
})

describe('avaliarCustoDaOrdemDosProjetos — vários projetos, em série, um defeito não trava os outros', () => {
  it('projeto A explode ao ler o quadro; projeto B é avaliado e perguntado igual', async () => {
    const onErro = vi.fn()
    const d = deps({
      projetos: async () => [P1, P2],
      filaDoQuadro: async (p) => {
        if (p.id === P1.id) throw new Error('GitHub fora do ar')
        return FILA_CARA
      },
      onErro,
    })

    const resumo = await avaliarCustoDaOrdemDosProjetos(d)
    expect(resumo).toEqual({ avaliados: 2, avisados: 1 })
    expect(onErro).toHaveBeenCalledTimes(1)
    expect(onErro).toHaveBeenCalledWith(P1, expect.any(Error))
    expect(d.avisar).toHaveBeenCalledTimes(1)
    expect((d.avisar as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(P2)
  })
})
