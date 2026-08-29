import { describe, it, expect, vi } from 'vitest'
import {
  garantirSprintNoQuadro,
  sprintCorrente,
  DIAS_DE_SPRINT_PADRAO,
  CAMPO_DE_SPRINT,
  type ClienteDeQuadro,
  type Iteracao,
} from './garantir-sprint.js'

// Os três estados vieram da conta do dono em 29/08: o quadro do gitorch não
// tinha campo de sprint (por isso o Roadmap dele abria com "Dates: none"), e o
// quadro do Jardim tinha o campo criado, com duração 0 e zero iterações —
// existia e não funcionava.

function cliente(over: Partial<ClienteDeQuadro> = {}): ClienteDeQuadro {
  return {
    getIterationField: vi.fn().mockRejectedValue(new Error('Iteration field not found')),
    criarCampoDeIteracao: vi.fn().mockResolvedValue({ fieldId: 'F_novo', name: 'Sprint' }),
    configurarCampoDeIteracao: vi.fn().mockResolvedValue('F_existente'),
    ...over,
  }
}

const iteracao = (over: Partial<Iteracao> = {}): Iteracao => ({
  id: 'it_1',
  title: 'Sprint 1',
  startDate: '2026-08-27',
  duration: 3,
  ...over,
})

describe('garantirSprintNoQuadro', () => {
  it('quadro SEM campo de sprint: cria — o caso do quadro do gitorch', () => {
    const c = cliente()
    return garantirSprintNoQuadro(c, { projectId: 'PVT_1', hoje: '2026-08-29' }).then((r) => {
      expect(r.estado).toBe('criado')
      expect(c.criarCampoDeIteracao).toHaveBeenCalledWith({
        projectId: 'PVT_1',
        fieldName: CAMPO_DE_SPRINT,
        duracaoEmDias: DIAS_DE_SPRINT_PADRAO,
        inicio: '2026-08-29',
      })
      expect(c.configurarCampoDeIteracao).not.toHaveBeenCalled()
    })
  })

  it('campo existe mas VAZIO: configura, não recria — o caso do quadro do Jardim', async () => {
    // Recriar perderia o vínculo dos itens que já apontam para este campo.
    const c = cliente({
      getIterationField: vi.fn().mockResolvedValue({ fieldId: 'F_9', iterations: [] }),
    })
    const r = await garantirSprintNoQuadro(c, { projectId: 'PVT_9', hoje: '2026-08-29' })
    expect(r.estado).toBe('configurado')
    expect(c.criarCampoDeIteracao).not.toHaveBeenCalled()
    expect(c.configurarCampoDeIteracao).toHaveBeenCalledWith(
      expect.objectContaining({ fieldId: 'F_9', duracaoEmDias: 3 })
    )
  })

  it('sprint JÁ configurada: não toca em nada', async () => {
    const c = cliente({
      getIterationField: vi
        .fn()
        .mockResolvedValue({ fieldId: 'F_ok', iterations: [iteracao(), iteracao({ id: 'it_2' })] }),
    })
    const r = await garantirSprintNoQuadro(c, { projectId: 'PVT_1', hoje: '2026-08-29' })
    expect(r.estado).toBe('ja_pronto')
    if (r.estado === 'ja_pronto') expect(r.iteracoes).toBe(2)
    expect(c.criarCampoDeIteracao).not.toHaveBeenCalled()
    expect(c.configurarCampoDeIteracao).not.toHaveBeenCalled()
  })

  it('idempotente: rodar de novo com a sprint pronta não muda nada', async () => {
    const c = cliente({
      getIterationField: vi.fn().mockResolvedValue({ fieldId: 'F_ok', iterations: [iteracao()] }),
    })
    const a = await garantirSprintNoQuadro(c, { projectId: 'PVT_1', hoje: '2026-08-29' })
    const b = await garantirSprintNoQuadro(c, { projectId: 'PVT_1', hoje: '2026-09-15' })
    expect(a.estado).toBe('ja_pronto')
    expect(b.estado).toBe('ja_pronto')
    expect(c.criarCampoDeIteracao).not.toHaveBeenCalled()
    expect(c.configurarCampoDeIteracao).not.toHaveBeenCalled()
  })

  it('a duração é do cliente quando ele escolhe', async () => {
    const c = cliente()
    await garantirSprintNoQuadro(c, { projectId: 'PVT_1', duracaoEmDias: 14, hoje: '2026-08-29' })
    expect(c.criarCampoDeIteracao).toHaveBeenCalledWith(
      expect.objectContaining({ duracaoEmDias: 14 })
    )
  })

  it('o padrão do produto é 3 dias', () => {
    expect(DIAS_DE_SPRINT_PADRAO).toBe(3)
  })
})

describe('sprintCorrente — o GitHub não marca qual está valendo', () => {
  const ciclos = [
    iteracao({ id: 'a', title: 'Sprint 1', startDate: '2026-08-24', duration: 3 }), // 24,25,26
    iteracao({ id: 'b', title: 'Sprint 2', startDate: '2026-08-27', duration: 3 }), // 27,28,29
    iteracao({ id: 'c', title: 'Sprint 3', startDate: '2026-09-01', duration: 3 }), // 1,2,3
  ]

  it('acha a que contém o dia', () => {
    expect(sprintCorrente(ciclos, '2026-08-28')?.title).toBe('Sprint 2')
    expect(sprintCorrente(ciclos, '2026-08-25')?.title).toBe('Sprint 1')
  })

  it('o primeiro dia entra e o dia seguinte ao fim NÃO', () => {
    expect(sprintCorrente(ciclos, '2026-08-27')?.id).toBe('b')
    expect(sprintCorrente(ciclos, '2026-08-30')).toBeNull()
  })

  it('dia no intervalo entre sprints devolve null — não se inventa sprint correndo', () => {
    // 30 e 31 de agosto não pertencem a ciclo nenhum.
    expect(sprintCorrente(ciclos, '2026-08-31')).toBeNull()
  })

  it('lista vazia devolve null', () => {
    expect(sprintCorrente([], '2026-08-29')).toBeNull()
  })
})
