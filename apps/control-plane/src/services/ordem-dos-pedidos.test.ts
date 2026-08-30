import { describe, it, expect, vi } from 'vitest'
import { EscritaNaoAutorizadaError } from '@gitorch/cadence'
import { aplicarOrdemDosPedidos, type DepsDaOrdem } from './ordem-dos-pedidos.js'

const PEDIDOS = [
  { pedido: 36, itemId: 'IT_36' },
  { pedido: 37, itemId: 'IT_37' },
  { pedido: 38, itemId: 'IT_38' },
]

function deps(over: Partial<DepsDaOrdem> = {}): DepsDaOrdem {
  return {
    quadro: { moverItemDoQuadro: vi.fn().mockResolvedValue(undefined) },
    nivel: () => 'cuidar',
    registrar: vi.fn().mockResolvedValue(undefined),
    agora: () => new Date('2026-08-30T01:00:00Z'),
    ...over,
  }
}

const movimentos = (d: DepsDaOrdem) =>
  (d.quadro.moverItemDoQuadro as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])

describe('a guarda de autonomia vem PRIMEIRO', () => {
  it('no nível "só olhar" NADA é movido — nem o primeiro item', async () => {
    // Recusar depois de já ter movido três itens deixaria o quadro do cliente
    // meio arrumado, que é pior que não ter mexido.
    const d = deps({ nivel: () => 'so_olhar' })
    await expect(
      aplicarOrdemDosPedidos(d, { projectId: 'PVT_1', pedidos: PEDIDOS })
    ).rejects.toBeInstanceOf(EscritaNaoAutorizadaError)
    expect(d.quadro.moverItemDoQuadro).not.toHaveBeenCalled()
    expect(d.registrar).not.toHaveBeenCalled()
  })

  it('reordenar é ORGANIZAR: o nível "sugerir" já basta', async () => {
    // Mexer na ordem não propõe trabalho novo nem mescla nada.
    const d = deps({ nivel: () => 'sugerir' })
    await aplicarOrdemDosPedidos(d, { projectId: 'PVT_1', pedidos: PEDIDOS })
    expect(d.quadro.moverItemDoQuadro).toHaveBeenCalledTimes(3)
  })

  it('nível desconhecido não vira permissão', async () => {
    const d = deps({ nivel: () => 'administrador' })
    await expect(
      aplicarOrdemDosPedidos(d, { projectId: 'PVT_1', pedidos: PEDIDOS })
    ).rejects.toBeInstanceOf(EscritaNaoAutorizadaError)
  })
})

describe('a ordem sai como o cliente pediu', () => {
  it('aplica DO COMEÇO PARA O FIM, ancorando em quem já foi posicionado', async () => {
    // ESTE TESTE NASCEU DE UM DEFEITO PEGO EM PRODUÇÃO. A versão anterior ia
    // de trás para frente, com o argumento certo aplicado ao contrário: o
    // segundo item era ancorado no primeiro ANTES de o primeiro se mover, e
    // depois o primeiro se movia sem o segundo acompanhar.
    //
    // Medido no quadro do dono, de [36,37,38] pedindo [38,36,37]:
    //   de trás para frente -> [38, 37, 36]   ERRADO
    //   do começo para o fim -> [38, 36, 37]  certo
    const d = deps()
    await aplicarOrdemDosPedidos(d, { projectId: 'PVT_1', pedidos: PEDIDOS })
    expect(movimentos(d)).toEqual([
      { projectId: 'PVT_1', itemId: 'IT_36' },
      { projectId: 'PVT_1', itemId: 'IT_37', depoisDe: 'IT_36' },
      { projectId: 'PVT_1', itemId: 'IT_38', depoisDe: 'IT_37' },
    ])
  })

  it('o PRIMEIRO vai para o topo — sem âncora, que é como o GitHub diz "primeiro"', async () => {
    const d = deps()
    await aplicarOrdemDosPedidos(d, { projectId: 'PVT_1', pedidos: PEDIDOS })
    const primeiro = movimentos(d)[0]
    expect(primeiro.itemId).toBe('IT_36')
    expect('depoisDe' in primeiro).toBe(false)
  })

  it('cada item é ancorado no ANTERIOR da lista, nunca no seguinte', async () => {
    // A regra que o defeito violava: a âncora tem que ser alguém que já foi
    // colocado nesta mesma passagem.
    const d = deps()
    await aplicarOrdemDosPedidos(d, { projectId: 'PVT_1', pedidos: PEDIDOS })
    const ms = movimentos(d)
    const jaPostos = new Set<string>()
    for (const m of ms) {
      if (m.depoisDe) expect(jaPostos.has(m.depoisDe)).toBe(true)
      jaPostos.add(m.itemId)
    }
  })

  it('um pedido só também funciona: vai para o topo', async () => {
    const d = deps()
    await aplicarOrdemDosPedidos(d, { projectId: 'PVT_1', pedidos: [PEDIDOS[0]!] })
    expect(movimentos(d)).toEqual([{ projectId: 'PVT_1', itemId: 'IT_36' }])
  })

  it('lista vazia é recusada — não é "não faça nada", é pedido sem sentido', async () => {
    const d = deps()
    await expect(aplicarOrdemDosPedidos(d, { projectId: 'PVT_1', pedidos: [] })).rejects.toThrow(
      'ORDEM_VAZIA'
    )
    expect(d.quadro.moverItemDoQuadro).not.toHaveBeenCalled()
  })
})

describe('o cliente pode ver o que o produto fez em nome dele', () => {
  it('o registro diz o que foi feito, em português, com a ordem', async () => {
    const d = deps()
    const r = await aplicarOrdemDosPedidos(d, { projectId: 'PVT_1', pedidos: PEDIDOS })
    expect(r.oQueFiz).toBe('Reordenei 3 pedido(s) no seu quadro: #36, #37, #38.')
    expect(r.ordem).toEqual([36, 37, 38])
    expect(r.quando).toBe('2026-08-30T01:00:00.000Z')
    expect(d.registrar).toHaveBeenCalledWith(r)
  })

  it('o registro vem DEPOIS da escrita — nunca antes', async () => {
    // Registrar antes e falhar no meio diria ao cliente que o produto fez algo
    // que não fez.
    const ordemDasChamadas: string[] = []
    const d = deps({
      quadro: {
        moverItemDoQuadro: vi.fn(async () => {
          ordemDasChamadas.push('moveu')
        }),
      },
      registrar: vi.fn(async () => {
        ordemDasChamadas.push('registrou')
      }),
    })
    await aplicarOrdemDosPedidos(d, { projectId: 'PVT_1', pedidos: PEDIDOS })
    expect(ordemDasChamadas[ordemDasChamadas.length - 1]).toBe('registrou')
    expect(ordemDasChamadas.filter((x) => x === 'moveu')).toHaveLength(3)
  })

  it('se a escrita falhar no meio, NADA é registrado', async () => {
    const d = deps({
      quadro: {
        moverItemDoQuadro: vi.fn().mockRejectedValue(new Error('rede caiu')),
      },
    })
    await expect(
      aplicarOrdemDosPedidos(d, { projectId: 'PVT_1', pedidos: PEDIDOS })
    ).rejects.toThrow('rede caiu')
    expect(d.registrar).not.toHaveBeenCalled()
  })
})
