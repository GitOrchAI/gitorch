import { describe, expect, it, vi } from 'vitest'
import {
  testarAmbiente,
  resolveCaminhosDeAmbiente,
  resolveEnderecoDeAmbiente,
} from './qa-de-ambiente.js'

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

describe('resolveCaminhosDeAmbiente', () => {
  it('sem runtimeConfig nenhum: padrão só a raiz', () => {
    expect(resolveCaminhosDeAmbiente(null)).toEqual(['/'])
    expect(resolveCaminhosDeAmbiente(undefined)).toEqual(['/'])
  })

  it('runtimeConfig sem a chave ambientes.caminhos: padrão só a raiz', () => {
    expect(resolveCaminhosDeAmbiente({})).toEqual(['/'])
    expect(resolveCaminhosDeAmbiente({ board: { sprintDays: 5 } })).toEqual(['/'])
  })

  it('lê os caminhos declarados pelo projeto', () => {
    expect(
      resolveCaminhosDeAmbiente({ ambientes: { caminhos: ['/', '/produtos', '/checkout'] } })
    ).toEqual(['/', '/produtos', '/checkout'])
  })

  it('caminhos malformado (não é array, ou array vazio): padrão só a raiz — nunca chuta rota', () => {
    expect(resolveCaminhosDeAmbiente({ ambientes: { caminhos: '/produtos' } })).toEqual(['/'])
    expect(resolveCaminhosDeAmbiente({ ambientes: { caminhos: [] } })).toEqual(['/'])
  })

  it('descarta entradas que não são texto (nunca inventa caminho a partir de lixo)', () => {
    expect(
      resolveCaminhosDeAmbiente({ ambientes: { caminhos: ['/produtos', 42, null, ''] } })
    ).toEqual(['/produtos'])
  })
})

// Item 1/Leva B2 (Menor 9 da revisão final): a metade que faltava de
// `resolveCaminhosDeAmbiente` — o endereço BASE do ambiente, não os
// caminhos dentro dele. Sem isto, o caminho de publicação por WORKFLOW nunca
// tinha o que testar (o GitHub não entrega endereço nenhum ali, ao contrário
// do caminho de deployment).
describe('resolveEnderecoDeAmbiente', () => {
  it('sem runtimeConfig nenhum: sem endereço, nunca inventa', () => {
    expect(resolveEnderecoDeAmbiente(null)).toBeNull()
    expect(resolveEnderecoDeAmbiente(undefined)).toBeNull()
  })

  it('runtimeConfig sem a chave ambientes.endereco: sem endereço', () => {
    expect(resolveEnderecoDeAmbiente({})).toBeNull()
    expect(resolveEnderecoDeAmbiente({ ambientes: { caminhos: ['/'] } })).toBeNull()
  })

  it('lê o endereço declarado pelo projeto', () => {
    expect(resolveEnderecoDeAmbiente({ ambientes: { endereco: 'https://loja.exemplo.com' } })).toBe(
      'https://loja.exemplo.com'
    )
  })

  it('descarta espaço em volta, mas não inventa nada além do que foi declarado', () => {
    expect(
      resolveEnderecoDeAmbiente({ ambientes: { endereco: '  https://loja.exemplo.com  ' } })
    ).toBe('https://loja.exemplo.com')
  })

  it('endereço malformado (não é texto, ou string vazia/só espaço): sem endereço, nunca chuta', () => {
    expect(resolveEnderecoDeAmbiente({ ambientes: { endereco: 42 } })).toBeNull()
    expect(resolveEnderecoDeAmbiente({ ambientes: { endereco: null } })).toBeNull()
    expect(resolveEnderecoDeAmbiente({ ambientes: { endereco: '' } })).toBeNull()
    expect(resolveEnderecoDeAmbiente({ ambientes: { endereco: '   ' } })).toBeNull()
  })

  it('caminhos e endereço convivem no mesmo bloco de configuração, cada um lido pela sua função', () => {
    const runtimeConfig = {
      ambientes: { endereco: 'https://loja.exemplo.com', caminhos: ['/', '/checkout'] },
    }
    expect(resolveEnderecoDeAmbiente(runtimeConfig)).toBe('https://loja.exemplo.com')
    expect(resolveCaminhosDeAmbiente(runtimeConfig)).toEqual(['/', '/checkout'])
  })
})
