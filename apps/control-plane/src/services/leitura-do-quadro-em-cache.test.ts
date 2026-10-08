import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  JANELA_DO_CACHE_DO_QUADRO_MS,
  esquecerLeituraDoQuadro,
  lerQuadroComCache,
  lerQuadroCompleto,
  limparCacheDeLeituraDoQuadro,
  type LeituraDoQuadro,
} from './leitura-do-quadro-em-cache.js'

const leitura = (itens: LeituraDoQuadro['itens'] = []): LeituraDoQuadro => ({
  itens,
  truncado: false,
  iteracaoCorrenteId: 'it_1',
})

describe('cache da leitura do quadro', () => {
  beforeEach(() => limparCacheDeLeituraDoQuadro())

  it('duas leituras do mesmo quadro dentro da janela fazem UMA ida ao GitHub', async () => {
    const carregar = vi.fn(async () => leitura())
    const t0 = new Date('2026-10-08T12:00:00Z')
    const a = await lerQuadroComCache('Q1', carregar, () => t0)
    const b = await lerQuadroComCache(
      'Q1',
      carregar,
      () => new Date(t0.getTime() + JANELA_DO_CACHE_DO_QUADRO_MS - 1)
    )
    expect(carregar).toHaveBeenCalledTimes(1)
    expect(b).toBe(a)
  })

  it('passada a janela, lê de novo', async () => {
    const carregar = vi.fn(async () => leitura())
    const t0 = new Date('2026-10-08T12:00:00Z')
    await lerQuadroComCache('Q1', carregar, () => t0)
    await lerQuadroComCache(
      'Q1',
      carregar,
      () => new Date(t0.getTime() + JANELA_DO_CACHE_DO_QUADRO_MS + 1)
    )
    expect(carregar).toHaveBeenCalledTimes(2)
  })

  it('quadros diferentes não se misturam', async () => {
    const carregar = vi.fn(async () => leitura())
    await lerQuadroComCache('Q1', carregar)
    await lerQuadroComCache('Q2', carregar)
    expect(carregar).toHaveBeenCalledTimes(2)
  })

  it('leituras simultâneas do mesmo quadro dividem a mesma ida ao GitHub', async () => {
    let liberar: (l: LeituraDoQuadro) => void = () => undefined
    const carregar = vi.fn(
      () =>
        new Promise<LeituraDoQuadro>((resolve) => {
          liberar = resolve
        })
    )
    const p1 = lerQuadroComCache('Q1', carregar)
    const p2 = lerQuadroComCache('Q1', carregar)
    liberar(leitura())
    await Promise.all([p1, p2])
    expect(carregar).toHaveBeenCalledTimes(1)
  })

  it('falha não fica guardada: a próxima tentativa lê de novo', async () => {
    const carregar = vi
      .fn<() => Promise<LeituraDoQuadro>>()
      .mockRejectedValueOnce(new Error('rede'))
      .mockResolvedValueOnce(leitura())
    await expect(lerQuadroComCache('Q1', carregar)).rejects.toThrow('rede')
    await expect(lerQuadroComCache('Q1', carregar)).resolves.toBeDefined()
    expect(carregar).toHaveBeenCalledTimes(2)
  })

  it('esquecerLeituraDoQuadro obriga a próxima leitura a ir ao GitHub', async () => {
    const carregar = vi.fn(async () => leitura())
    await lerQuadroComCache('Q1', carregar)
    esquecerLeituraDoQuadro('Q1')
    await lerQuadroComCache('Q1', carregar)
    expect(carregar).toHaveBeenCalledTimes(2)
  })
})

describe('lerQuadroCompleto', () => {
  const cliente = (opcoes: {
    itens?: Array<{ pedido: number; peso: number | null; iteracaoId: string | null }>
    campo?:
      | 'ausente'
      | { iterations: Array<{ id: string; title: string; startDate: string; duration: number }> }
    truncar?: boolean
  }) => ({
    listarItensDoQuadro: vi.fn(
      async (
        _id: string,
        o?: { onTruncado?: (n: number) => void; campoDePeso?: string; campoDeSprint?: string }
      ) => {
        if (opcoes.truncar) o?.onTruncado?.(2000)
        return (opcoes.itens ?? []).map((i, n) => ({
          itemId: `item${n}`,
          corpo: null,
          ...i,
        }))
      }
    ),
    getIterationField: vi.fn(async () => {
      if (opcoes.campo === 'ausente' || opcoes.campo === undefined) {
        const erro = new Error('campo ausente')
        erro.name = 'CampoDeIteracaoAusenteError'
        throw erro
      }
      return { fieldId: 'f', iterations: opcoes.campo.iterations }
    }),
  })

  it('pede peso, sprint e corpo numa leitura só e acha a iteração de hoje', async () => {
    const c = cliente({
      itens: [{ pedido: 1, peso: 3, iteracaoId: 'it_hoje' }],
      campo: {
        iterations: [
          { id: 'it_velha', title: 'S0', startDate: '2026-09-01', duration: 3 },
          { id: 'it_hoje', title: 'S1', startDate: '2026-10-07', duration: 3 },
        ],
      },
    })
    const l = await lerQuadroCompleto(c, 'Q1', '2026-10-08')
    expect(l.iteracaoCorrenteId).toBe('it_hoje')
    expect(l.truncado).toBe(false)
    expect(l.itens).toHaveLength(1)
    expect(c.listarItensDoQuadro).toHaveBeenCalledTimes(1)
    expect(c.listarItensDoQuadro.mock.calls[0]?.[1]).toMatchObject({
      campoDePeso: 'Peso',
      campoDeSprint: 'Sprint',
      comCorpo: true,
    })
  })

  it('sem o campo Sprint, a iteração corrente fica desconhecida (null), não inventada', async () => {
    const l = await lerQuadroCompleto(cliente({ campo: 'ausente' }), 'Q1', '2026-10-08')
    expect(l.iteracaoCorrenteId).toBeNull()
  })

  it('entre duas sprints (nenhuma corre hoje) a iteração corrente é null', async () => {
    const l = await lerQuadroCompleto(
      cliente({
        campo: {
          iterations: [{ id: 'it_velha', title: 'S0', startDate: '2026-09-01', duration: 3 }],
        },
      }),
      'Q1',
      '2026-10-08'
    )
    expect(l.iteracaoCorrenteId).toBeNull()
  })

  it('leitura cortada pelo teto de páginas marca truncado', async () => {
    const l = await lerQuadroCompleto(
      cliente({ campo: 'ausente', truncar: true }),
      'Q1',
      '2026-10-08'
    )
    expect(l.truncado).toBe(true)
  })
})
