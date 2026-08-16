import { describe, expect, it, vi } from 'vitest'
import { testarAmbiente } from './qa-de-ambiente.js'

describe('testarAmbiente', () => {
  it('sem endereço nenhum: diz que não tem, não inventa veredito', async () => {
    const r = await testarAmbiente({ enderecos: [], caminhos: ['/'], buscar: vi.fn() })
    expect(r.veredito).toBe('sem-endereco')
  })

  it('endereço interno é recusado antes de qualquer chamada', async () => {
    const buscar = vi.fn()
    const r = await testarAmbiente({
      enderecos: ['http://127.0.0.1:3011'],
      caminhos: ['/'],
      buscar,
    })
    expect(r.veredito).toBe('inalcancavel')
    expect(buscar).not.toHaveBeenCalled()
    expect(r.motivo).toMatch(/interna|alcance/i)
  })

  it('todas as telas respondem: passou', async () => {
    const r = await testarAmbiente({
      enderecos: ['https://exemplo.test'],
      caminhos: ['/', '/produtos'],
      buscar: vi.fn().mockResolvedValue({ status: 200, corpo: '<html>ok</html>' }),
    })
    expect(r.veredito).toBe('passou')
    expect(r.testes).toHaveLength(2)
  })

  it('uma tela quebrada: falhou, e diz qual', async () => {
    const buscar = vi
      .fn()
      .mockResolvedValueOnce({ status: 200, corpo: 'ok' })
      .mockResolvedValueOnce({ status: 500, corpo: 'erro' })
    const r = await testarAmbiente({
      enderecos: ['https://exemplo.test'],
      caminhos: ['/', '/produtos'],
      buscar,
    })
    expect(r.veredito).toBe('falhou')
    expect(r.testes.find((t) => t.caminho === '/produtos')?.ok).toBe(false)
  })

  it('rede caiu no meio: inalcançável, nunca "passou"', async () => {
    const r = await testarAmbiente({
      enderecos: ['https://exemplo.test'],
      caminhos: ['/'],
      buscar: vi.fn().mockRejectedValue(new Error('tempo esgotado')),
    })
    expect(r.veredito).toBe('inalcancavel')
  })
})
