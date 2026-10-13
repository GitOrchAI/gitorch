import { describe, expect, it, vi } from 'vitest'
import { vigiarTravaEsquecida } from './aviso-de-trava-esquecida.js'

const desde = new Date('2030-01-01T10:00:00Z')
const horas = (h: number) => new Date(desde.getTime() + h * 3_600_000)

function montar() {
  const avisar = vi.fn().mockResolvedValue(true)
  const registrarNoPainel = vi.fn().mockResolvedValue(undefined)
  const log = { warn: vi.fn() }
  const base = {
    listarProjetos: vi.fn().mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]),
    avisar,
    registrarNoPainel,
    log,
  }
  return { base, avisar, registrarNoPainel, log }
}

describe('vigiarTravaEsquecida', () => {
  it('trava desligada: não avisa e zera a marca', async () => {
    const { base, avisar, registrarNoPainel } = montar()
    const marca = await vigiarTravaEsquecida({
      ...base,
      estado: { ligada: false, desde: null, motivo: null, ligadaPor: null },
      ultimoAviso: horas(3),
      agora: horas(10),
    })
    expect(marca).toBeNull()
    expect(avisar).not.toHaveBeenCalled()
    expect(registrarNoPainel).not.toHaveBeenCalled()
  })

  it('ligada há 1 hora: nada ainda', async () => {
    const { base, avisar } = montar()
    const marca = await vigiarTravaEsquecida({
      ...base,
      estado: { ligada: true, desde, motivo: 'troca', ligadaPor: 'entregador' },
      ultimoAviso: null,
      agora: horas(1),
    })
    expect(marca).toBeNull()
    expect(avisar).not.toHaveBeenCalled()
    expect(base.listarProjetos).not.toHaveBeenCalled()
  })

  it('ligada há 2 horas: UM aviso no Telegram e um registro no painel de cada projeto', async () => {
    const { base, avisar, registrarNoPainel, log } = montar()
    const marca = await vigiarTravaEsquecida({
      ...base,
      estado: { ligada: true, desde, motivo: 'troca', ligadaPor: 'entregador' },
      ultimoAviso: null,
      agora: horas(2),
    })
    expect(marca).toEqual(horas(2))
    expect(avisar).toHaveBeenCalledTimes(1)
    expect(avisar.mock.calls[0]![0]).toMatch(/atualização/i)
    expect(registrarNoPainel).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenCalled()
  })

  it('os tiques seguintes dentro do mesmo período não repetem o aviso', async () => {
    const { base, avisar, registrarNoPainel } = montar()
    const estado = { ligada: true, desde, motivo: 'troca', ligadaPor: 'entregador' }
    let marca: Date | null = null
    for (const h of [2, 2.01, 2.5, 3, 3.99]) {
      marca = await vigiarTravaEsquecida({
        ...base,
        estado,
        ultimoAviso: marca,
        agora: horas(h),
      })
    }
    expect(avisar).toHaveBeenCalledTimes(1)
    expect(registrarNoPainel).toHaveBeenCalledTimes(2)
    // e o período seguinte (4 h) volta a avisar uma vez
    await vigiarTravaEsquecida({ ...base, estado, ultimoAviso: marca, agora: horas(4) })
    expect(avisar).toHaveBeenCalledTimes(2)
  })

  it('canal de aviso fora do ar não derruba nem impede o registro no painel', async () => {
    const { base, avisar, registrarNoPainel } = montar()
    avisar.mockRejectedValue(new Error('telegram fora'))
    const marca = await vigiarTravaEsquecida({
      ...base,
      estado: { ligada: true, desde, motivo: 'troca', ligadaPor: 'entregador' },
      ultimoAviso: null,
      agora: horas(2),
    })
    expect(marca).toEqual(horas(2))
    expect(registrarNoPainel).toHaveBeenCalledTimes(2)
  })

  it('sem canal de aviso configurado (null) ainda registra no painel', async () => {
    const { base, registrarNoPainel } = montar()
    await vigiarTravaEsquecida({
      ...base,
      avisar: null,
      estado: { ligada: true, desde, motivo: null, ligadaPor: null },
      ultimoAviso: null,
      agora: horas(2),
    })
    expect(registrarNoPainel).toHaveBeenCalledTimes(2)
  })
})
