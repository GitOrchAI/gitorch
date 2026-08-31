import { describe, it, expect, vi } from 'vitest'
import { EscritaNaoAutorizadaError } from '@gitorch/cadence'
import {
  ETIQUETAS_DE_QUEM_ESTA_COM_A_BOLA,
  levantarTrabalhoAtivo,
  preencherSprintCorrente,
  selecionarParaSprint,
} from './sprint-com-itens.js'

const ITERACAO_CORRENTE = {
  id: 'c1434f3d',
  title: 'Sprint 1',
  startDate: '2026-08-30',
  duration: 3,
}
const ITERACAO_VELHA = { id: 'velha', title: 'Sprint 0', startDate: '2026-08-20', duration: 3 }

/** Um quadro de mentira que ANOTA o que foi escrito, não só que foi chamado. */
function quadroDeMentira(input: {
  iteracoes?: Array<{ id: string; title: string; startDate: string; duration: number }>
  itens?: Array<{ itemId: string; pedido: number; iteracaoId: string | null }>
  truncado?: number
}) {
  const escritas: Array<{ itemId: string; iterationId: string }> = []
  return {
    escritas,
    getIterationField: vi.fn(async () => ({
      fieldId: 'PVTIF_1',
      iterations: input.iteracoes ?? [ITERACAO_CORRENTE],
    })),
    listarItensDoQuadro: vi.fn(
      async (
        _projectId: string,
        opcoes?: { campoDeSprint?: string; onTruncado?: (lidos: number) => void }
      ) => {
        if (input.truncado !== undefined) opcoes?.onTruncado?.(input.truncado)
        return input.itens ?? []
      }
    ),
    setIterationField: vi.fn(
      async (i: { projectId: string; itemId: string; fieldId: string; iterationId: string }) => {
        escritas.push({ itemId: i.itemId, iterationId: i.iterationId })
        return i.itemId
      }
    ),
  }
}

describe('quem entra na sprint — o critério de entrada', () => {
  it('a etiqueta do PO NÃO põe ninguém na sprint (medido: 50 issues abertas com ela)', () => {
    // Medido em 31/08/2026 no quadro do dono: `gitorch:agent:po` estava em 50
    // das 52 issues abertas com etiqueta de agente. É carimbo de QUEM CRIOU a
    // árvore, não de quem está com a bola — tratá-la como trabalho ativo
    // puxaria o backlog inteiro para dentro do ciclo.
    expect(ETIQUETAS_DE_QUEM_ESTA_COM_A_BOLA).not.toContain('gitorch:agent:po')
    expect(ETIQUETAS_DE_QUEM_ESTA_COM_A_BOLA).not.toContain('gitorch:agent:ra')
    expect([...ETIQUETAS_DE_QUEM_ESTA_COM_A_BOLA].sort()).toEqual([
      'gitorch:agent:jules',
      'gitorch:agent:qa',
      'gitorch:agent:sm',
    ])
  })

  it('junta sessão viva, PR ligado e etiqueta de execução, sem repetir pedido', async () => {
    const ativos = await levantarTrabalhoAtivo({
      sessoesVivas: async () => [
        { issueNumber: 265, pullRequestNumber: 408 },
        { issueNumber: 3681, pullRequestNumber: null },
      ],
      issuesComEtiquetaDeExecucao: async () => [265, 344],
    })

    // 265 aparece por dois caminhos e entra UMA vez, pelo motivo mais forte.
    expect(ativos).toEqual([
      { pedido: 265, motivo: 'missao-ativa' },
      { pedido: 3681, motivo: 'missao-ativa' },
      { pedido: 408, motivo: 'pr-aberto' },
      { pedido: 344, motivo: 'etiqueta-de-execucao' },
    ])
  })
})

describe('selecionarParaSprint — a decisão, sem rede', () => {
  const itens = [
    { itemId: 'PVTI_a', pedido: 265, iteracaoId: null },
    { itemId: 'PVTI_b', pedido: 408, iteracaoId: null },
    { itemId: 'PVTI_c', pedido: 309, iteracaoId: 'c1434f3d' },
    { itemId: 'PVTI_d', pedido: 100, iteracaoId: 'velha' },
    // O backlog: 3 pedidos que ninguém está tocando.
    { itemId: 'PVTI_e', pedido: 37, iteracaoId: null },
    { itemId: 'PVTI_f', pedido: 38, iteracaoId: null },
    { itemId: 'PVTI_g', pedido: 39, iteracaoId: null },
  ]

  it('só o trabalho ativo entra — o backlog inteiro fica de fora', () => {
    const r = selecionarParaSprint({
      itens,
      ativos: [
        { pedido: 265, motivo: 'missao-ativa' },
        { pedido: 408, motivo: 'pr-aberto' },
      ],
      iteracaoCorrenteId: 'c1434f3d',
    })

    expect(r.entram).toEqual([
      { itemId: 'PVTI_a', pedido: 265, motivo: 'missao-ativa' },
      { itemId: 'PVTI_b', pedido: 408, motivo: 'pr-aberto' },
    ])
    expect(r.entram.map((e) => e.pedido)).not.toContain(37)
  })

  it('quem já está na iteração corrente NÃO é reescrito', () => {
    const r = selecionarParaSprint({
      itens,
      ativos: [{ pedido: 309, motivo: 'etiqueta-de-execucao' }],
      iteracaoCorrenteId: 'c1434f3d',
    })

    expect(r.entram).toEqual([])
    expect(r.jaEstavam).toEqual([309])
  })

  it('quem está em OUTRA iteração não é arrastado para a de agora', () => {
    const r = selecionarParaSprint({
      itens,
      ativos: [{ pedido: 100, motivo: 'missao-ativa' }],
      iteracaoCorrenteId: 'c1434f3d',
    })

    expect(r.entram).toEqual([])
    expect(r.emOutraIteracao).toEqual([100])
  })

  it('pedido ativo que não está no quadro é dito, não inventado', () => {
    const r = selecionarParaSprint({
      itens,
      ativos: [{ pedido: 9999, motivo: 'pr-aberto' }],
      iteracaoCorrenteId: 'c1434f3d',
    })

    expect(r.entram).toEqual([])
    expect(r.foraDoQuadro).toEqual([9999])
  })
})

describe('preencherSprintCorrente — a passada inteira', () => {
  const trabalhoAtivo = async () =>
    [
      { pedido: 265, motivo: 'missao-ativa' },
      { pedido: 309, motivo: 'etiqueta-de-execucao' },
    ] as const

  const itensDoQuadro = [
    { itemId: 'PVTI_a', pedido: 265, iteracaoId: null },
    { itemId: 'PVTI_c', pedido: 309, iteracaoId: 'c1434f3d' },
    { itemId: 'PVTI_e', pedido: 37, iteracaoId: null },
  ]

  it('escreve SÓ quem falta, e escreve a iteração corrente', async () => {
    const quadro = quadroDeMentira({ itens: itensDoQuadro })

    const r = await preencherSprintCorrente(
      { quadro, nivel: () => 'cuidar', trabalhoAtivo, hoje: () => '2026-08-31' },
      { projectId: 'PVT_1' }
    )

    expect(quadro.escritas).toEqual([{ itemId: 'PVTI_a', iterationId: 'c1434f3d' }])
    expect(r.iteracao).toEqual({ id: 'c1434f3d', titulo: 'Sprint 1' })
    expect(r.entraram.map((e) => e.pedido)).toEqual([265])
    expect(r.jaEstavam).toEqual([309])
  })

  it('a segunda passada não escreve nada — a idempotência é MEDIDA no estado', async () => {
    // Primeira passada com o item fora da sprint; segunda com o quadro já no
    // estado que a primeira deixou. É o que a prova em produção faz.
    const depois = itensDoQuadro.map((i) =>
      i.pedido === 265 ? { ...i, iteracaoId: 'c1434f3d' } : i
    )
    const quadro = quadroDeMentira({ itens: depois })

    const r = await preencherSprintCorrente(
      { quadro, nivel: () => 'cuidar', trabalhoAtivo, hoje: () => '2026-08-31' },
      { projectId: 'PVT_1' }
    )

    expect(quadro.escritas).toEqual([])
    expect(r.entraram).toEqual([])
    expect([...r.jaEstavam].sort()).toEqual([265, 309])
  })

  it('recusa ANTES de ler o quadro quando o cliente não autorizou', async () => {
    const quadro = quadroDeMentira({ itens: itensDoQuadro })

    await expect(
      preencherSprintCorrente(
        { quadro, nivel: () => 'so_olhar', trabalhoAtivo, hoje: () => '2026-08-31' },
        { projectId: 'PVT_1' }
      )
    ).rejects.toBeInstanceOf(EscritaNaoAutorizadaError)

    expect(quadro.getIterationField).not.toHaveBeenCalled()
    expect(quadro.escritas).toEqual([])
  })

  it('fora de qualquer ciclo: não escreve e DIZ por quê', async () => {
    const quadro = quadroDeMentira({ itens: itensDoQuadro })

    const r = await preencherSprintCorrente(
      // 2026-09-05 está depois do fim da única iteração (30/08 + 3 dias).
      { quadro, nivel: () => 'cuidar', trabalhoAtivo, hoje: () => '2026-09-05' },
      { projectId: 'PVT_1' }
    )

    expect(quadro.escritas).toEqual([])
    expect(r.iteracao).toBeNull()
    expect(r.oQueFiz).toContain('nenhum ciclo')
  })

  it('leitura cortada pelo teto é dita, não escondida', async () => {
    const quadro = quadroDeMentira({ itens: itensDoQuadro, truncado: 2000 })

    const r = await preencherSprintCorrente(
      { quadro, nivel: () => 'cuidar', trabalhoAtivo, hoje: () => '2026-08-31' },
      { projectId: 'PVT_1' }
    )

    expect(r.leituraIncompleta).toBe(true)
    expect(r.oQueFiz).toContain('não consegui ler o seu quadro inteiro')
  })

  it('sem trabalho ativo não escreve nada — sprint vazia é melhor que sprint mentirosa', async () => {
    const quadro = quadroDeMentira({ itens: itensDoQuadro })

    const r = await preencherSprintCorrente(
      { quadro, nivel: () => 'cuidar', trabalhoAtivo: async () => [], hoje: () => '2026-08-31' },
      { projectId: 'PVT_1' }
    )

    expect(quadro.escritas).toEqual([])
    expect(quadro.listarItensDoQuadro).not.toHaveBeenCalled()
    expect(r.entraram).toEqual([])
  })

  it('quadro com iteração antiga e corrente escolhe a corrente', async () => {
    const quadro = quadroDeMentira({
      iteracoes: [ITERACAO_VELHA, ITERACAO_CORRENTE],
      itens: itensDoQuadro,
    })

    await preencherSprintCorrente(
      { quadro, nivel: () => 'cuidar', trabalhoAtivo, hoje: () => '2026-08-31' },
      { projectId: 'PVT_1' }
    )

    expect(quadro.escritas).toEqual([{ itemId: 'PVTI_a', iterationId: 'c1434f3d' }])
  })
})
