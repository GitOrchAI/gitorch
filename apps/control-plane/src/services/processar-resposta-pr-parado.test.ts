import { describe, expect, it, vi } from 'vitest'
import { processarRespostaPrParado } from './processar-resposta-pr-parado.js'

describe('processarRespostaPrParado', () => {
  it('chama mesclar', async () => {
    const deps = {
      mesclar: vi.fn(),
      pedirAjuste: vi.fn(),
      fecharPr: vi.fn(),
      registrarNoPainel: vi.fn(),
    }
    await processarRespostaPrParado(
      { dedupKey: 'cuida-deste-pedido:dono/repo:42', resposta: 'pr-parado-mesclar' },
      deps
    )
    expect(deps.mesclar).toHaveBeenCalledWith('dono/repo', 42)
  })
})
