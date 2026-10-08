import { describe, it, expect, vi } from 'vitest'
import {
  criarConferidorDeTarefa,
  criarResolvedorComCache,
  type DepsDoConferidor,
  type IssueParaConferir,
  type QuadroParaConferir,
} from './conferencia-no-retrato.js'
import type { ConferenciaGravada } from './conferir-tarefa-sem-pedido.js'

const AGORA = new Date('2026-10-08T12:00:00.000Z')

const CORPO_NO_PADRAO = [
  '## Goal',
  'g',
  '## Task Details',
  'd',
  '## Task Description',
  'd',
  '## Implementation Guide',
  'i com passo concreto',
  '## Verification Criteria',
  'rodar `pnpm test` e ver 0 falhas',
  '## Dependencies',
  'nenhuma',
  '## Related Files',
  'src/x.ts',
  '## Notes',
  'n',
  '## Peso',
  '**3**',
].join('\n\n')

const issue = (numero: number, extra: Partial<IssueParaConferir> = {}): IssueParaConferir => ({
  numero,
  titulo: `Tarefa ${numero}`,
  corpo: CORPO_NO_PADRAO,
  etiquetas: ['gitorch:task'],
  ...extra,
})

function quadro(
  itens: Array<[number, string | null]>,
  extra: Partial<QuadroParaConferir> = {}
): QuadroParaConferir {
  return {
    itens: new Map(itens.map(([n, it]) => [n, { iteracaoId: it }])),
    iteracaoCorrenteId: 'it_hoje',
    truncado: false,
    ...extra,
  }
}

/** Um "banco" em memória que sobrevive de um ciclo para o outro. */
function montar(
  q: QuadroParaConferir | null,
  banco: Map<number, Record<string, unknown> | null> = new Map()
) {
  const gravadas: Array<{ numero: number; conferencia: ConferenciaGravada }> = []
  const eventos: Array<{ chave: string; texto: string }> = []
  const lerQuadro = vi.fn(async () => q)
  const lerConferenciasAnteriores = vi.fn(async () => new Map(banco))
  const deps: DepsDoConferidor = {
    repo: 'acme/api',
    lerQuadro,
    lerConferenciasAnteriores,
    gravarConferencia: async (numero, conferencia) => {
      gravadas.push({ numero, conferencia })
      banco.set(numero, { ...(banco.get(numero) ?? {}), ...conferencia })
    },
    registrarNoPainel: async (e) => {
      eventos.push(e)
    },
    agora: () => AGORA,
    onWarn: vi.fn(),
  }
  return { conferir: criarConferidorDeTarefa(deps), gravadas, eventos, lerQuadro, banco, deps }
}

describe('conferidor da tarefa na varredura do retrato', () => {
  it('tarefa no padrão, na sprint de hoje: grava ok e não faz barulho no painel', async () => {
    const m = montar(quadro([[10, 'it_hoje']]))
    await m.conferir(issue(10))
    expect(m.gravadas).toHaveLength(1)
    expect(m.gravadas[0]?.conferencia).toMatchObject({
      padraoOk: true,
      pesoOk: true,
      estaNoQuadro: true,
      naSprint: true,
      conferidoEm: AGORA.toISOString(),
    })
    expect(m.eventos).toEqual([])
  })

  it('tarefa fora do padrão: grava os campos que faltam e abre UM evento com a chave estável', async () => {
    const m = montar(quadro([[11, null]]))
    await m.conferir(issue(11, { corpo: 'só um parágrafo solto' }))
    const g = m.gravadas[0]?.conferencia
    expect(g?.padraoOk).toBe(false)
    expect(g?.camposFaltando).toContain('goal')
    expect(g?.naSprint).toBe(false)
    expect(m.eventos).toHaveLength(1)
    expect(m.eventos[0]?.chave).toBe(`conferencia:acme/api:11:${g?.hashDosErros}`)
    expect(m.eventos[0]?.texto).toContain('#11')
  })

  it('segunda passada sem mudança: não regrava e não repete o evento', async () => {
    const banco = new Map<number, Record<string, unknown> | null>()
    const um = montar(quadro([[11, null]]), banco)
    await um.conferir(issue(11, { corpo: 'solto' }))
    const dois = montar(quadro([[11, null]]), banco)
    await dois.conferir(issue(11, { corpo: 'solto' }))
    expect(dois.gravadas).toEqual([])
    expect(dois.eventos).toEqual([])
  })

  it('corpo mudou: regrava; erros iguais não repetem o evento, erros novos abrem outro', async () => {
    const banco = new Map<number, Record<string, unknown> | null>()
    const um = montar(quadro([[11, null]]), banco)
    await um.conferir(issue(11, { corpo: 'solto' }))
    const dois = montar(quadro([[11, null]]), banco)
    await dois.conferir(issue(11, { corpo: 'outro texto solto' }))
    expect(dois.gravadas).toHaveLength(1)
    expect(dois.eventos).toEqual([]) // mesmos erros

    const tres = montar(quadro([[11, null]]), banco)
    await tres.conferir(issue(11, { corpo: '## Goal\n\ng' }))
    expect(tres.gravadas).toHaveLength(1)
    expect(tres.eventos).toHaveLength(1) // erros diferentes
  })

  it('o quadro mudou (entrou na sprint): regrava, sem evento novo', async () => {
    const banco = new Map<number, Record<string, unknown> | null>()
    await montar(quadro([[12, null]]), banco).conferir(issue(12, { corpo: 'solto' }))
    const dois = montar(quadro([[12, 'it_hoje']]), banco)
    await dois.conferir(issue(12, { corpo: 'solto' }))
    expect(dois.gravadas).toHaveLength(1)
    expect(dois.gravadas[0]?.conferencia.naSprint).toBe(true)
    expect(dois.eventos).toEqual([])
  })

  it('quando a tarefa passa a seguir o padrão depois de ter falhado, registra a virada', async () => {
    const banco = new Map<number, Record<string, unknown> | null>()
    await montar(quadro([[13, null]]), banco).conferir(issue(13, { corpo: 'solto' }))
    const dois = montar(quadro([[13, null]]), banco)
    await dois.conferir(issue(13))
    expect(dois.eventos).toHaveLength(1)
    expect(dois.eventos[0]?.texto).toContain('passou a seguir o padrão')
  })

  it('bug solto, fora do quadro e sem etiqueta de tarefa, não é conferido', async () => {
    const m = montar(quadro([]))
    await m.conferir(issue(20, { etiquetas: ['bug'], corpo: 'quebrou' }))
    expect(m.gravadas).toEqual([])
    expect(m.eventos).toEqual([])
  })

  it('issue no quadro, mesmo sem etiqueta de tarefa, é conferida', async () => {
    const m = montar(quadro([[21, null]]))
    await m.conferir(issue(21, { etiquetas: [], corpo: 'feita à mão' }))
    expect(m.gravadas).toHaveLength(1)
    expect(m.gravadas[0]?.conferencia.estaNoQuadro).toBe(true)
  })

  it('o que não é tarefa de execução fica de fora: fase, épico, feature, desejo e incidente', async () => {
    const m = montar(
      quadro([
        [30, null],
        [31, null],
        [32, null],
        [33, null],
        [34, null],
      ])
    )
    await m.conferir(issue(30, { corpo: '<!-- gitorch:node:5:phase:0 -->\n\nFase', etiquetas: [] }))
    await m.conferir(issue(31, { corpo: '<!-- gitorch:node:5:epic:1 -->\n\nÉpico', etiquetas: [] }))
    await m.conferir(issue(32, { corpo: '<!-- gitorch:node:5:feature:2 -->\n\nF', etiquetas: [] }))
    await m.conferir(issue(33, { corpo: 'quero uma coisa', etiquetas: ['wishlist'] }))
    await m.conferir(issue(34, { corpo: 'falhou o CI', etiquetas: ['gitorch:incident'] }))
    expect(m.gravadas).toEqual([])
  })

  it('lê o quadro UMA vez por ciclo, mesmo com muitas tarefas', async () => {
    const m = montar(
      quadro([
        [40, null],
        [41, null],
        [42, null],
      ])
    )
    await m.conferir(issue(40))
    await m.conferir(issue(41))
    await m.conferir(issue(42))
    expect(m.lerQuadro).toHaveBeenCalledTimes(1)
    expect(m.deps.lerConferenciasAnteriores).toHaveBeenCalledTimes(1)
  })

  it('não lê o quadro nem o banco se nenhuma issue é candidata', async () => {
    const m = montar(quadro([]))
    await m.conferir(issue(50, { etiquetas: ['wishlist'] }))
    expect(m.lerQuadro).not.toHaveBeenCalled()
  })

  it('quadro ilegível: tarefa etiquetada é conferida só pelo corpo, com o quadro desconhecido', async () => {
    const m = montar(null)
    await m.conferir(issue(60))
    expect(m.gravadas).toHaveLength(1)
    expect(m.gravadas[0]?.conferencia).toMatchObject({
      padraoOk: true,
      estaNoQuadro: null,
      naSprint: null,
    })
  })

  it('quadro ilegível e sem etiqueta de tarefa: não dá para saber que é tarefa, então não confere', async () => {
    const m = montar(null)
    await m.conferir(issue(61, { etiquetas: [] }))
    expect(m.gravadas).toEqual([])
  })

  it('quadro ilegível numa passada seguinte não apaga o que se sabia do quadro', async () => {
    const banco = new Map<number, Record<string, unknown> | null>()
    await montar(quadro([[62, 'it_hoje']]), banco).conferir(issue(62))
    const dois = montar(null, banco)
    await dois.conferir(issue(62)) // mesmo corpo
    expect(dois.gravadas).toEqual([])
    expect(banco.get(62)).toMatchObject({ estaNoQuadro: true, naSprint: true })
  })

  it('leitura do quadro cortada: quem não aparece na lista fica com o quadro desconhecido', async () => {
    const m = montar(quadro([[70, null]], { truncado: true }))
    await m.conferir(issue(71))
    expect(m.gravadas[0]?.conferencia).toMatchObject({ estaNoQuadro: null, naSprint: null })
  })

  it('sem sprint correndo hoje, naSprint é desconhecido; fora do quadro é falso do mesmo jeito', async () => {
    const m = montar(quadro([[80, 'it_velha']], { iteracaoCorrenteId: null }))
    await m.conferir(issue(80))
    await m.conferir(issue(81))
    expect(m.gravadas[0]?.conferencia).toMatchObject({ estaNoQuadro: true, naSprint: null })
    expect(m.gravadas[1]?.conferencia).toMatchObject({ estaNoQuadro: false, naSprint: false })
  })

  it('a etiqueta de quem está com a bola marca emExecucao', async () => {
    const m = montar(quadro([[90, null]]))
    await m.conferir(issue(90, { etiquetas: ['gitorch:task', 'gitorch:agent:sm'] }))
    expect(m.gravadas[0]?.conferencia.emExecucao).toBe(true)
  })
})

describe('criarResolvedorComCache', () => {
  it('acha o quadro uma vez por janela e por projeto', async () => {
    let agora = new Date('2026-10-08T12:00:00Z')
    const resolver = vi.fn(async (id: string) => ({ quadroId: `Q-${id}` }))
    const achar = criarResolvedorComCache(resolver, { validadeMs: 1000, agora: () => agora })
    expect(await achar('p1')).toEqual({ quadroId: 'Q-p1' })
    expect(await achar('p1')).toEqual({ quadroId: 'Q-p1' })
    expect(await achar('p2')).toEqual({ quadroId: 'Q-p2' })
    expect(resolver).toHaveBeenCalledTimes(2)
    agora = new Date(agora.getTime() + 1001)
    await achar('p1')
    expect(resolver).toHaveBeenCalledTimes(3)
  })

  it('"sem quadro" (null) não fica guardado: a próxima passada tenta de novo', async () => {
    const resolver = vi
      .fn<(id: string) => Promise<{ quadroId: string } | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ quadroId: 'Q1' })
    const achar = criarResolvedorComCache(resolver, { validadeMs: 60_000 })
    expect(await achar('p1')).toBeNull()
    expect(await achar('p1')).toEqual({ quadroId: 'Q1' })
    expect(resolver).toHaveBeenCalledTimes(2)
  })
})
