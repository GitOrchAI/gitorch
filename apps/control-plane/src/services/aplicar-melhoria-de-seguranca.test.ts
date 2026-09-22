import { describe, it, expect, vi } from 'vitest'
import {
  planoPermiteMelhoria,
  aplicarMelhoriaDeSeguranca,
} from './aplicar-melhoria-de-seguranca.js'

describe('planoPermiteMelhoria', () => {
  it('branch protection: sempre permitido em repo público, qualquer plano', () => {
    expect(planoPermiteMelhoria('branch-protection', 'free', false)).toBe(true)
  })
  it('branch protection em repo privado: só a partir do Pro', () => {
    expect(planoPermiteMelhoria('branch-protection', 'free', true)).toBe(false)
    expect(planoPermiteMelhoria('branch-protection', 'pro', true)).toBe(true)
  })
  it('secret scanning avançado: exige Advanced Security em repo privado (Team/Enterprise)', () => {
    expect(planoPermiteMelhoria('secret-scanning', 'pro', true)).toBe(false)
    expect(planoPermiteMelhoria('secret-scanning', 'enterprise', true)).toBe(true)
  })
  it('secret scanning: grátis em repo público, qualquer plano', () => {
    expect(planoPermiteMelhoria('secret-scanning', 'free', false)).toBe(true)
  })
})

describe('aplicarMelhoriaDeSeguranca', () => {
  it('se plano não permite e autonomia é so_olhar, sugere alternativa gratuita e não escreve', async () => {
    const aplicar = vi.fn()
    const aplicarAlternativa = vi.fn()
    const res = await aplicarMelhoriaDeSeguranca({
      repository: 'dono/repo',
      melhoria: 'secret-scanning',
      plano: 'free',
      repoPrivado: true,
      autonomiaDeSeguranca: 'so_olhar',
      aplicar,
      aplicarAlternativa,
    })
    expect(res.aplicado).toBe(false)
    expect(res.motivo).toMatch(/Sugestão de alternativa gratuita/)
    expect(aplicar).not.toHaveBeenCalled()
    expect(aplicarAlternativa).not.toHaveBeenCalled()
  })

  it('se plano não permite e autonomia é cuidar, grava alternativa gratuita e retorna aplicado', async () => {
    const aplicar = vi.fn()
    const aplicarAlternativa = vi.fn().mockResolvedValue(undefined)
    const res = await aplicarMelhoriaDeSeguranca({
      repository: 'dono/repo',
      melhoria: 'secret-scanning',
      plano: 'free',
      repoPrivado: true,
      autonomiaDeSeguranca: 'cuidar',
      aplicar,
      aplicarAlternativa,
    })
    expect(res.aplicado).toBe(true)
    expect(res.motivo).toMatch(/alternativa gratuita gravada/)
    expect(aplicar).not.toHaveBeenCalled()
    expect(aplicarAlternativa).toHaveBeenCalledTimes(1)
    expect(aplicarAlternativa).toHaveBeenCalledWith(expect.stringContaining('gitleaks'))
  })

  it('devolve aplicado: false se o recurso é indisponível no plano, sem chamar aplicar', async () => {
    const aplicar = vi.fn()
    const res = await aplicarMelhoriaDeSeguranca({
      repository: 'dono/repo',
      melhoria: 'branch-protection',
      plano: 'free',
      repoPrivado: true,
      autonomiaDeSeguranca: 'cuidar',
      aplicar,
    })
    expect(res.aplicado).toBe(false)
    expect(res.motivo).toMatch(/o plano "free" do GitHub não permite/)
    expect(aplicar).not.toHaveBeenCalled()
  })

  it('devolve aplicado: false se autonomia é so_olhar, sem chamar aplicar', async () => {
    const aplicar = vi.fn()
    const res = await aplicarMelhoriaDeSeguranca({
      repository: 'dono/repo',
      melhoria: 'branch-protection',
      plano: 'pro',
      repoPrivado: true,
      autonomiaDeSeguranca: 'so_olhar',
      aplicar,
    })
    expect(res.aplicado).toBe(false)
    expect(res.motivo).toMatch(/Não posso/i)
    expect(aplicar).not.toHaveBeenCalled()
  })

  it('devolve aplicado: false se autonomia é sugerir, sem chamar aplicar', async () => {
    const aplicar = vi.fn()
    const res = await aplicarMelhoriaDeSeguranca({
      repository: 'dono/repo',
      melhoria: 'branch-protection',
      plano: 'pro',
      repoPrivado: true,
      autonomiaDeSeguranca: 'sugerir',
      aplicar,
    })
    expect(res.aplicado).toBe(false)
    expect(res.motivo).toMatch(/Não posso/i)
    expect(aplicar).not.toHaveBeenCalled()
  })

  it('devolve aplicado: true se autonomia é cuidar e plano permite, chamando aplicar', async () => {
    const aplicar = vi.fn()
    const res = await aplicarMelhoriaDeSeguranca({
      repository: 'dono/repo',
      melhoria: 'branch-protection',
      plano: 'pro',
      repoPrivado: true,
      autonomiaDeSeguranca: 'cuidar',
      aplicar,
    })
    expect(res.aplicado).toBe(true)
    expect(res.motivo).toMatch(/aplicada/)
    expect(aplicar).toHaveBeenCalledTimes(1)
  })

  it('devolve aplicado: false tratando falha da API caso o aplicar lance erro', async () => {
    const aplicar = vi.fn().mockRejectedValue(new Error('Network Error'))
    const res = await aplicarMelhoriaDeSeguranca({
      repository: 'dono/repo',
      melhoria: 'branch-protection',
      plano: 'pro',
      repoPrivado: true,
      autonomiaDeSeguranca: 'cuidar',
      aplicar,
    })
    expect(res.aplicado).toBe(false)
    expect(res.motivo).toMatch(/falha na API: Network Error/)
    expect(aplicar).toHaveBeenCalledTimes(1)
  })
})
