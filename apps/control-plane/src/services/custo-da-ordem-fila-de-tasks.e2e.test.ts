import { describe, expect, it, vi } from 'vitest'
import { filtrarFilaDeTasks, type ItemDoQuadroParaFiltrar } from './filtrar-fila-de-tasks.js'
import {
  avaliarCustoDaOrdemDosProjetos,
  type DepsDeCustoDaOrdem,
  type ProjetoParaAvaliar,
} from './custo-da-ordem-do-projeto.js'
import { analisarCustoDaOrdem, LIMIAR_PONTOS_MINIMOS, LIMIAR_RAZAO } from '@gitorch/cadence'

// A COSTURA que faltava (D9 + D1, 01/09). `filtrar-fila-de-tasks.test.ts`
// prova que o filtro descarta fase/épico/feature/incidente. Já
// `custo-da-ordem-do-projeto.test.ts` prova que o aviso sai com o candidato
// certo — mas monta a fila À MÃO (`FILA_CARA: PedidoNaFila[] = [...]`),
// nunca passando pelo filtro de verdade. Nenhum dos dois prova que o formato
// que `filtrarFilaDeTasks` DEVOLVE é literalmente o que
// `avaliarCustoDaOrdemDosProjetos` (e `analisarCustoDaOrdem`, por dentro)
// esperam CONSUMIR. Se um dia o formato de um lado mudar sem o outro
// acompanhar, nenhum dos dois arquivos pega — só este.
//
// Este arquivo exercita a costura inteira, no MESMO formato de dependência
// que o scheduler.ts real usa (`filaDoQuadro`, em plugins/scheduler.ts):
//
//   quadro cru (checkpoints + incidentes sem peso, tasks com peso)
//     -> filtrarFilaDeTasks (de verdade)
//     -> avaliarCustoDaOrdemDosProjetos (chama analisarCustoDaOrdem por dentro)
//     -> avisar (o texto que o dono veria)

const CORPO_DE_TASK = (wish: number, i: number) =>
  `## Peso\n\n<!-- gitorch:node:${wish}:task:${i} -->`
const CORPO_DE_FASE = (wish: number, i: number) => `<!-- gitorch:node:${wish}:phase:${i} -->`
const CORPO_DE_EPICO = (wish: number, i: number) => `<!-- gitorch:node:${wish}:epic:${i} -->`
const CORPO_DE_FEATURE = (wish: number, i: number) => `<!-- gitorch:node:${wish}:feature:${i} -->`
const CORPO_DE_INCIDENTE = (id: string) => `<!-- gitorch:incident:${id} -->`

const PROJETO: ProjetoParaAvaliar = { id: 'proj_costura', wingId: 'acme/api' }

/**
 * Quadro cru no formato REAL: os 4 tipos de agrupador (fase/épico/feature/
 * incidente), todos sem peso e sem marcador de task, MISTURADOS com as
 * tasks — o mesmo desenho do quadro real medido em D9 (124 itens, 48 sem
 * peso por desenho). #101/#102/#103 são as únicas tasks, todas com peso na
 * ESCALA_DE_PESO.
 */
function quadroCru(): ItemDoQuadroParaFiltrar[] {
  return [
    { pedido: 1, peso: null, corpo: CORPO_DE_FASE(100, 0) },
    { pedido: 2, peso: null, corpo: CORPO_DE_EPICO(100, 0) },
    { pedido: 3, peso: null, corpo: CORPO_DE_FEATURE(100, 0) },
    { pedido: 4, peso: null, corpo: CORPO_DE_INCIDENTE('inc-abc') },
    { pedido: 101, peso: 13, corpo: CORPO_DE_TASK(100, 0) },
    { pedido: 102, peso: 1, corpo: CORPO_DE_TASK(100, 1) },
    { pedido: 103, peso: 2, corpo: CORPO_DE_TASK(100, 2) },
  ]
}

/**
 * `filaDoQuadro` no MESMO formato do scheduler.ts real: roda o filtro de
 * verdade sobre o quadro cru e devolve `filtro.fila` ou `null`. Nunca monta
 * `PedidoNaFila[]` à mão — é exatamente essa costura que faltava provar.
 */
function depsQueLeemOFiltro(
  itens: ItemDoQuadroParaFiltrar[],
  over: Partial<DepsDeCustoDaOrdem> = {}
): DepsDeCustoDaOrdem {
  return {
    projetos: async () => [PROJETO],
    filaDoQuadro: async () => filtrarFilaDeTasks(itens).fila,
    lerEstado: async () => ({ ultimoPedidoProposto: null, silencio: null, ordemProposta: null }),
    salvarEstado: vi.fn().mockResolvedValue(undefined),
    avisar: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

describe('a costura ponta a ponta: quadro cru -> filtro -> cálculo -> aviso', () => {
  it('checkpoints e incidentes sem peso, tasks com peso: o filtro sai limpo, o cálculo roda, o AVISO SAI com o pedido e o número certos', async () => {
    const itens = quadroCru()

    // Sanidade, com os LIMIARES LIDOS do próprio módulo (nunca chutados):
    // este caso precisa ser gritante o bastante para passar os dois pisos,
    // não um caso limítrofe que só passa por arredondamento.
    const filtro = filtrarFilaDeTasks(itens)
    expect(filtro.fila).not.toBeNull()
    const analiseDireta = analisarCustoDaOrdem(filtro.fila!)
    expect(analiseDireta.custaCaro).toBe(true)
    if (analiseDireta.custaCaro) {
      expect(analiseDireta.candidato.perda).toBeGreaterThanOrEqual(LIMIAR_PONTOS_MINIMOS * 4)
      expect(analiseDireta.candidato.razao).toBeGreaterThanOrEqual(LIMIAR_RAZAO * 6)
    }

    // A COSTURA DE VERDADE: passa pelo caminho real, sem recriar a fila no
    // meio — `filaDoQuadro` roda `filtrarFilaDeTasks` por dentro, igual ao
    // scheduler.ts em produção.
    const d = depsQueLeemOFiltro(itens)
    const resumo = await avaliarCustoDaOrdemDosProjetos(d)

    expect(resumo).toEqual({ avaliados: 1, avisados: 1 })
    expect(d.avisar).toHaveBeenCalledTimes(1)
    const [projetoAvisado, candidato, rodada] = (d.avisar as ReturnType<typeof vi.fn>).mock
      .calls[0]!
    expect(projetoAvisado).toBe(PROJETO)
    // #102 (peso 1) preso atrás de #101 (peso 13): perda 13, razão 13 — bem
    // acima dos dois limiares.
    expect(candidato).toMatchObject({ pedido: 102, perda: 13 })
    expect(rodada).toBe(1)
  })

  it('caso espelho: UMA task sem peso no meio -> a prudência barra -> filtro fica null -> NENHUM aviso sai', async () => {
    const itens = quadroCru().map((item) => (item.pedido === 102 ? { ...item, peso: null } : item))

    const filtro = filtrarFilaDeTasks(itens)
    expect(filtro.fila).toBeNull()
    expect(filtro).toMatchObject({ motivo: 'sem-peso', totalDeTasks: 3, semPeso: [102] })

    const d = depsQueLeemOFiltro(itens)
    const resumo = await avaliarCustoDaOrdemDosProjetos(d)

    expect(resumo).toEqual({ avaliados: 1, avisados: 0 })
    expect(d.avisar).not.toHaveBeenCalled()
    expect(d.salvarEstado).not.toHaveBeenCalled()
  })
})
