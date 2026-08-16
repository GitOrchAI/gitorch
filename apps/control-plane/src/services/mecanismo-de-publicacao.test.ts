import { describe, expect, it, vi } from 'vitest'
import { descobrirMecanismo } from './mecanismo-de-publicacao.js'

describe('descobrirMecanismo', () => {
  it('prefere o mecanismo de deployment quando há ambiente declarado', async () => {
    const m = await descobrirMecanismo({
      listarAmbientes: vi.fn().mockResolvedValue(['github-pages']),
      listarWorkflows: vi.fn().mockResolvedValue([]),
    })
    expect(m).toEqual({ tipo: 'deployment', ambientes: ['github-pages'] })
  })

  it('ignora ambiente efêmero de entrega (um por entrega aberta)', async () => {
    const m = await descobrirMecanismo({
      listarAmbientes: vi
        .fn()
        .mockResolvedValue([
          'minha-branch-123 - projeto-staging PR #2447',
          'outra-branch-9 - projeto PR #2996',
        ]),
      listarWorkflows: vi
        .fn()
        .mockResolvedValue([{ nome: 'CD', arquivo: '.github/workflows/cd.yml', ativo: true }]),
    })
    expect(m).toEqual({ tipo: 'workflow', arquivo: 'cd.yml', nome: 'CD' })
  })

  it('reconhece o workflow de publicação pelo nome, sem confundir com o CI ao lado', async () => {
    const m = await descobrirMecanismo({
      listarAmbientes: vi.fn().mockResolvedValue([]),
      listarWorkflows: vi.fn().mockResolvedValue([
        { nome: 'CI', arquivo: '.github/workflows/ci.yml', ativo: true },
        { nome: 'CD', arquivo: '.github/workflows/cd.yml', ativo: true },
      ]),
    })
    // Confere o resultado inteiro, não só `tipo` — prova que foi o CD que
    // casou, e não o CI por engano.
    expect(m).toEqual({ tipo: 'workflow', arquivo: 'cd.yml', nome: 'CD' })
  })

  it('não confunde verificação com publicação', async () => {
    const m = await descobrirMecanismo({
      listarAmbientes: vi.fn().mockResolvedValue([]),
      listarWorkflows: vi
        .fn()
        .mockResolvedValue([{ nome: 'CI', arquivo: '.github/workflows/ci.yml', ativo: true }]),
    })
    expect(m).toEqual({ tipo: 'nenhum' })
  })

  it('ignora workflow desligado', async () => {
    const m = await descobrirMecanismo({
      listarAmbientes: vi.fn().mockResolvedValue([]),
      listarWorkflows: vi
        .fn()
        .mockResolvedValue([{ nome: 'CD', arquivo: '.github/workflows/cd.yml', ativo: false }]),
    })
    expect(m).toEqual({ tipo: 'nenhum' })
  })
})
