import { describe, it, expect } from 'vitest'
import { ehEntregaSemConteudo, textoDeEntregaSemConteudo } from './entrega-sem-conteudo.js'

describe('ehEntregaSemConteudo', () => {
  it('changed_files = 0 é entrega sem conteúdo, mesmo com additions/deletions ausentes', () => {
    expect(ehEntregaSemConteudo({ changed_files: 0 })).toBe(true)
  })

  it('changed_files = 0 e additions/deletions também 0 (o formato real do PR #468)', () => {
    expect(ehEntregaSemConteudo({ changed_files: 0, additions: 0, deletions: 0 })).toBe(true)
  })

  it('changed_files > 0 nunca é vazio, mesmo que additions/deletions estejam ausentes', () => {
    expect(ehEntregaSemConteudo({ changed_files: 3 })).toBe(false)
  })

  it('sem changed_files, recua para additions/deletions: as duas 0 é vazio', () => {
    expect(ehEntregaSemConteudo({ additions: 0, deletions: 0 })).toBe(true)
  })

  it('sem changed_files, additions ou deletions > 0 não é vazio', () => {
    expect(ehEntregaSemConteudo({ additions: 5, deletions: 0 })).toBe(false)
    expect(ehEntregaSemConteudo({ additions: 0, deletions: 2 })).toBe(false)
  })

  it('nenhum dos três campos presente: não dá para dizer que é vazio — false por padrão', () => {
    expect(ehEntregaSemConteudo({})).toBe(false)
  })
})

describe('textoDeEntregaSemConteudo', () => {
  it('diz explicitamente que o commit não chegou a ser empurrado, e cita o número do PR', () => {
    const texto = textoDeEntregaSemConteudo(468)
    expect(texto).toContain('#468')
    expect(texto).toContain('never reached the repository')
    expect(texto).toContain('no commit was pushed')
    expect(texto).toContain('Do not')
  })
})
