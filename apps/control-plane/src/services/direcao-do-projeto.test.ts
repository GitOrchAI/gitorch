import { describe, it, expect, vi } from 'vitest'
import { registrarDirecaoDoProjeto } from './direcao-do-projeto.js'

describe('registrarDirecaoDoProjeto', () => {
  it('origem pessoa/assistente grava gaveta para o RA e para o PO', async () => {
    const cortex = { recallLocal: vi.fn(() => []), writeDrawer: vi.fn(async () => undefined) }
    await registrarDirecaoDoProjeto({
      projectId: 'proj-1',
      origem: 'pessoa',
      entendimento: {
        deOndeVeio: 'Outra pessoa',
        oQueMuda: 'novo endpoint de exportação',
        queAjusteE: 'funcionalidade nova',
        porQueExiste: 'cliente pediu exportar relatório em CSV',
      },
      deps: { cortex, now: () => '2026-09-15T00:00:00.000Z' },
    })
    expect(cortex.writeDrawer).toHaveBeenCalledTimes(2)
    const salas = (cortex.writeDrawer as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].roomId)
    expect(salas.sort()).toEqual(['po', 'ra'])
  })

  it('origem jules_gitorch/dependabot NÃO grava nada — não é direção de fora', async () => {
    const cortex = { recallLocal: vi.fn(() => []), writeDrawer: vi.fn(async () => undefined) }
    await registrarDirecaoDoProjeto({
      projectId: 'proj-1',
      origem: 'jules_gitorch',
      entendimento: {
        deOndeVeio: 'Jules pelo GitOrch',
        oQueMuda: 'x',
        queAjusteE: 'correção',
        porQueExiste: 'y',
      },
      deps: { cortex, now: () => '2026-09-15T00:00:00.000Z' },
    })
    expect(cortex.writeDrawer).not.toHaveBeenCalled()
  })
})
