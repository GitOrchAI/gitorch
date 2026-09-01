import { describe, it, expect, vi } from 'vitest'
import {
  extrairPeso,
  extrairWishNumber,
  origemDoIncremento,
  buscarCamposDoIncremento,
  CAMPOS_VAZIOS,
  type DepsDoEnriquecimento,
  type IssueResumo,
} from './enriquecer-incremento.js'

// O corpo REAL que renderIssueBody (backlog-executor.ts) produz para uma
// TASK nascida de uma wish do dono: marker gitorch:node + seção ## Peso.
const CORPO_DE_TASK_DA_WISH = [
  '<!-- gitorch:node:311:task:2 -->',
  '## Peso',
  '',
  '**8** (escala 1, 2, 3, 5, 8, 13)',
  '',
  'Toca 3 módulos, sem endpoint novo.',
  '## Contexto',
  '',
  'texto qualquer',
].join('\n\n')

const issue = (over: Partial<IssueResumo> = {}): IssueResumo => ({
  titulo: 'A árvore aparece no painel',
  corpo: CORPO_DE_TASK_DA_WISH,
  criadaEm: new Date('2026-08-20T10:00:00Z'),
  sprint: 'Sprint 3',
  ...over,
})

describe('extrairWishNumber — a wish que gerou esta task, pelo marker gravado no corpo', () => {
  it('acha o número da wish num corpo de task real', () => {
    expect(extrairWishNumber(CORPO_DE_TASK_DA_WISH)).toBe(311)
  })

  it('issue sem marker (proativa: conserto, aviso, incidente) devolve nulo', () => {
    expect(extrairWishNumber('## Contexto\n\ntexto qualquer, sem marker nenhum')).toBeNull()
  })

  it('corpo nulo devolve nulo, nunca inventa', () => {
    expect(extrairWishNumber(null)).toBeNull()
  })

  it('reconhece marker de phase/epic/feature, não só de task', () => {
    expect(extrairWishNumber('<!-- gitorch:node:42:phase:0 -->')).toBe(42)
    expect(extrairWishNumber('<!-- gitorch:node:42:epic:1 -->')).toBe(42)
    expect(extrairWishNumber('<!-- gitorch:node:42:feature:3 -->')).toBe(42)
  })
})

describe('origemDoIncremento — pedido do dono ou melhoria proativa do produto', () => {
  it('task com marker de wish é PEDIDO — só nasce de uma issue wishlist do dono', () => {
    expect(origemDoIncremento(CORPO_DE_TASK_DA_WISH)).toBe('pedido')
  })

  it('issue direta (conserto de publicação, aviso, incidente liberado) é PROATIVO', () => {
    expect(origemDoIncremento('## DoD\n\nissue de conserto, sem marker de wish')).toBe('proativo')
  })

  it('corpo nulo é PROATIVO — sem marker não dá para provar que veio de pedido', () => {
    expect(origemDoIncremento(null)).toBe('proativo')
  })
})

describe('extrairPeso — o mesmo número que já vai pro corpo da issue (backlog-executor)', () => {
  it('lê o peso da seção ## Peso, no formato real que renderIssueBody produz', () => {
    expect(extrairPeso(CORPO_DE_TASK_DA_WISH)).toBe(8)
  })

  it('issue sem seção de peso (proativa, sem estimativa) devolve nulo — não inventa', () => {
    expect(extrairPeso('## Contexto\n\nsem peso nenhum aqui')).toBeNull()
  })

  it('corpo nulo devolve nulo', () => {
    expect(extrairPeso(null)).toBeNull()
  })

  it('reconhece qualquer valor da escala (1,2,3,5,8,13)', () => {
    expect(extrairPeso('## Peso\n\n**13** (escala 1, 2, 3, 5, 8, 13)\n\nrationale')).toBe(13)
    expect(extrairPeso('## Peso\n\n**1** (escala 1, 2, 3, 5, 8, 13)\n\nrationale')).toBe(1)
  })
})

function deps(over: Partial<DepsDoEnriquecimento> = {}): DepsDoEnriquecimento {
  return {
    buscarIssue: vi.fn().mockResolvedValue(issue()),
    buscarPR: vi.fn().mockResolvedValue({ mescladoEm: new Date('2026-08-25T18:00:00Z') }),
    ...over,
  }
}

describe('buscarCamposDoIncremento — os seis campos, a partir de fatos que já existem no GitHub', () => {
  it('task de uma wish do dono: pedido, com o wishCreatedAt da WISH (não da task)', async () => {
    const buscarIssue = vi
      .fn()
      .mockResolvedValueOnce(issue()) // a própria task (#42)
      .mockResolvedValueOnce(issue({ criadaEm: new Date('2026-08-01T09:00:00Z') })) // a wish #311
    const d = deps({ buscarIssue })

    const campos = await buscarCamposDoIncremento(d, { issueNumber: 42, pullRequestNumber: 7 })

    expect(campos.titulo).toBe('A árvore aparece no painel')
    expect(campos.peso).toBe(8)
    expect(campos.sprint).toBe('Sprint 3')
    expect(campos.pedidoOuProativo).toBe('pedido')
    // a wish foi consultada pelo número extraído do marker (311), não pela task (42)
    expect(buscarIssue).toHaveBeenNthCalledWith(2, 311)
    expect(campos.wishCreatedAt).toEqual(new Date('2026-08-01T09:00:00Z'))
    expect(campos.mergedAt).toEqual(new Date('2026-08-25T18:00:00Z'))
  })

  it('issue proativa (sem wish): wishCreatedAt é a criação da PRÓPRIA issue', async () => {
    const buscarIssue = vi.fn().mockResolvedValue(issue({ corpo: '## DoD\n\nconserto direto' }))
    const d = deps({ buscarIssue })

    const campos = await buscarCamposDoIncremento(d, { issueNumber: 99, pullRequestNumber: null })

    expect(campos.pedidoOuProativo).toBe('proativo')
    expect(buscarIssue).toHaveBeenCalledTimes(1) // nunca busca uma "wish" que não existe
    expect(campos.wishCreatedAt).toEqual(issue().criadaEm)
    expect(campos.mergedAt).toBeNull() // sem PR, não há o que perguntar ao GitHub
  })

  it('sem PR (fechou sem entrega aberta), não tenta buscar PR nenhum', async () => {
    const buscarPR = vi.fn()
    const d = deps({ buscarPR })
    await buscarCamposDoIncremento(d, { issueNumber: 42, pullRequestNumber: null })
    expect(buscarPR).not.toHaveBeenCalled()
  })

  it('GitHub fora do ar ao buscar a issue: devolve os seis campos vazios, nunca lança', async () => {
    const d = deps({ buscarIssue: vi.fn().mockRejectedValue(new Error('502')) })
    const campos = await buscarCamposDoIncremento(d, { issueNumber: 42, pullRequestNumber: 7 })
    expect(campos).toEqual(CAMPOS_VAZIOS)
  })

  it('issue da task ok, mas a busca da WISH falha: os campos da task sobrevivem, só wishCreatedAt cai', async () => {
    const buscarIssue = vi
      .fn()
      .mockResolvedValueOnce(issue())
      .mockRejectedValueOnce(new Error('404'))
    const d = deps({ buscarIssue })
    const campos = await buscarCamposDoIncremento(d, { issueNumber: 42, pullRequestNumber: 7 })
    expect(campos.titulo).toBe('A árvore aparece no painel')
    expect(campos.peso).toBe(8)
    // não inventa uma data: sem confirmar a wish, fica nulo — não usa a da task.
    expect(campos.wishCreatedAt).toBeNull()
  })

  it('sem dependência de PR (buscarPR ausente): mergedAt fica nulo, sem quebrar o resto', async () => {
    const d = deps({ buscarPR: undefined })
    const campos = await buscarCamposDoIncremento(d, { issueNumber: 42, pullRequestNumber: 7 })
    expect(campos.mergedAt).toBeNull()
    expect(campos.titulo).toBe('A árvore aparece no painel')
  })

  it('busca da PR falha: mergedAt nulo, resto do registro sobrevive', async () => {
    const d = deps({ buscarPR: vi.fn().mockRejectedValue(new Error('timeout')) })
    const campos = await buscarCamposDoIncremento(d, { issueNumber: 42, pullRequestNumber: 7 })
    expect(campos.mergedAt).toBeNull()
    expect(campos.titulo).toBe('A árvore aparece no painel')
  })

  it('issue não encontrada (404 tratado como null pelo chamador): seis campos vazios', async () => {
    const d = deps({ buscarIssue: vi.fn().mockResolvedValue(null) })
    const campos = await buscarCamposDoIncremento(d, { issueNumber: 42, pullRequestNumber: 7 })
    expect(campos).toEqual(CAMPOS_VAZIOS)
  })
})
