import { describe, it, expect, vi } from 'vitest'
import { registrarEntendimentoDoPedido } from './entendimento-do-pedido.js'

describe('registrarEntendimentoDoPedido', () => {
  it('grava na ficha e na memória do projeto', async () => {
    const atualizarFicha = vi.fn(async () => undefined)
    const cortex = { recallLocal: vi.fn(() => []), writeDrawer: vi.fn(async () => undefined) }

    await registrarEntendimentoDoPedido({
      projectId: 'proj-1',
      numeroDoPr: 42,
      entendimento: {
        deOndeVeio: 'Jules pelo GitOrch',
        oQueMuda: 'ajusta o cache de sessão',
        queAjusteE: 'correção',
        porQueExiste: 'sessão expirava cedo demais',
      },
      deps: { atualizarFicha, cortex, now: () => '2026-09-15T00:00:00.000Z' },
    })

    expect(atualizarFicha).toHaveBeenCalledTimes(1)
    expect(cortex.writeDrawer).toHaveBeenCalledTimes(1)
  })
})
