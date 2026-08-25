import { describe, it, expect, vi } from 'vitest'
import {
  GAVETAS_POR_SALA,
  memoriaDoPapel,
  papelAprendeComOProjeto,
  salasQueOPapelLe,
} from './memoria-por-papel.js'

describe('salasQueOPapelLe', () => {
  // O defeito medido: o QA julgava do zero toda vez, sem lembrar o que já
  // tinha apontado naquele repositório.
  it('o juiz lê os PRÓPRIOS pareceres', () => {
    expect(salasQueOPapelLe('qa')).toContain('qa')
  })

  it('o explorador lê o que ele mesmo já mapeou', () => {
    expect(salasQueOPapelLe('ra')).toContain('ra')
  })

  it('o PO continua lendo o RA e o QA, como já era', () => {
    expect([...salasQueOPapelLe('po')].sort()).toEqual(['qa', 'ra'])
  })

  // Ele é determinístico, sem motor de IA. Dar memória a ele mudaria a
  // natureza do papel, e o dono não pediu isso.
  it('o SM não lê nada, e isso é desenho', () => {
    expect(salasQueOPapelLe('sm')).toEqual([])
    expect(papelAprendeComOProjeto('sm')).toBe(false)
  })

  it('papel desconhecido não quebra nem inventa sala', () => {
    expect(salasQueOPapelLe('inexistente')).toEqual([])
  })
})

describe('memoriaDoPapel', () => {
  const gaveta = (content: string, createdAt: string) => ({ content, createdAt })

  it('traz o mais recente primeiro, dentro de cada sala', () => {
    const lerSala = vi.fn((sala: string) =>
      sala === 'qa'
        ? [gaveta('parecer velho', '2026-08-01'), gaveta('parecer novo', '2026-08-25')]
        : []
    )
    const m = memoriaDoPapel({ papel: 'qa', lerSala })
    expect(m[0]?.content).toBe('parecer novo')
  })

  // Pagar duas vezes pelo mesmo texto é desperdício puro: cada gaveta é texto
  // que o motor lê e cobra por.
  it('a mesma gaveta em duas salas entra uma vez só', () => {
    const repetida = gaveta('o CI deste projeto quebra no lint', '2026-08-20')
    const lerSala = vi.fn(() => [repetida])
    expect(memoriaDoPapel({ papel: 'qa', lerSala })).toHaveLength(1)
  })

  // Memória demais encarece todo julgamento sem deixá-lo melhor.
  it('respeita o teto por sala', () => {
    const muitas = Array.from({ length: 10 }, (_, i) => gaveta(`g${i}`, `2026-08-${10 + i}`))
    const lerSala = vi.fn((sala: string) => (sala === 'qa' ? muitas : []))
    expect(memoriaDoPapel({ papel: 'qa', lerSala })).toHaveLength(GAVETAS_POR_SALA)
  })

  it('o SM não lê sala nenhuma, nem gasta a chamada', () => {
    const lerSala = vi.fn(() => [gaveta('qualquer coisa', '2026-08-25')])
    expect(memoriaDoPapel({ papel: 'sm', lerSala })).toEqual([])
    expect(lerSala).not.toHaveBeenCalled()
  })

  it('projeto sem memória nenhuma não quebra', () => {
    expect(memoriaDoPapel({ papel: 'qa', lerSala: () => [] })).toEqual([])
  })
})
