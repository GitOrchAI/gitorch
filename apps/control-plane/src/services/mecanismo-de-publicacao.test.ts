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

  it('não confunde "cd-lint-check" com publicação — o "cd" aí é coincidência de nome', async () => {
    const m = await descobrirMecanismo({
      listarAmbientes: vi.fn().mockResolvedValue([]),
      listarWorkflows: vi
        .fn()
        .mockResolvedValue([
          { nome: 'cd-lint-check', arquivo: '.github/workflows/cd-lint-check.yml', ativo: true },
        ]),
    })
    expect(m).toEqual({ tipo: 'nenhum' })
  })

  it('não confunde "cd-tests" nem "cd_build" com publicação', async () => {
    const m1 = await descobrirMecanismo({
      listarAmbientes: vi.fn().mockResolvedValue([]),
      listarWorkflows: vi
        .fn()
        .mockResolvedValue([
          { nome: 'cd-tests', arquivo: '.github/workflows/cd-tests.yml', ativo: true },
        ]),
    })
    expect(m1).toEqual({ tipo: 'nenhum' })

    const m2 = await descobrirMecanismo({
      listarAmbientes: vi.fn().mockResolvedValue([]),
      listarWorkflows: vi
        .fn()
        .mockResolvedValue([
          { nome: 'cd_build', arquivo: '.github/workflows/cd_build.yml', ativo: true },
        ]),
    })
    expect(m2).toEqual({ tipo: 'nenhum' })
  })

  it('continua reconhecendo "cd" sozinho e "cd.yml" — o nome real mais comum', async () => {
    const m1 = await descobrirMecanismo({
      listarAmbientes: vi.fn().mockResolvedValue([]),
      listarWorkflows: vi
        .fn()
        .mockResolvedValue([
          { nome: 'cd', arquivo: '.github/workflows/outro-nome.yml', ativo: true },
        ]),
    })
    expect(m1).toEqual({ tipo: 'workflow', arquivo: 'outro-nome.yml', nome: 'cd' })

    const m2 = await descobrirMecanismo({
      listarAmbientes: vi.fn().mockResolvedValue([]),
      listarWorkflows: vi
        .fn()
        .mockResolvedValue([
          { nome: 'Publicação', arquivo: '.github/workflows/cd.yml', ativo: true },
        ]),
    })
    expect(m2).toEqual({ tipo: 'workflow', arquivo: 'cd.yml', nome: 'Publicação' })
  })

  it('"deploy-tests" continua reconhecido — "deploy" é palavra inteira e inequívoca', async () => {
    const m = await descobrirMecanismo({
      listarAmbientes: vi.fn().mockResolvedValue([]),
      listarWorkflows: vi
        .fn()
        .mockResolvedValue([
          { nome: 'deploy-tests', arquivo: '.github/workflows/deploy-tests.yml', ativo: true },
        ]),
    })
    expect(m).toEqual({ tipo: 'workflow', arquivo: 'deploy-tests.yml', nome: 'deploy-tests' })
  })

  it('desempate: entre vários workflows ativos que casam, vence o primeiro da lista devolvida (comportamento atual, fixado por teste)', async () => {
    const m = await descobrirMecanismo({
      listarAmbientes: vi.fn().mockResolvedValue([]),
      listarWorkflows: vi.fn().mockResolvedValue([
        { nome: 'Deploy A', arquivo: '.github/workflows/deploy-a.yml', ativo: true },
        { nome: 'Deploy B', arquivo: '.github/workflows/deploy-b.yml', ativo: true },
      ]),
    })
    expect(m).toEqual({ tipo: 'workflow', arquivo: 'deploy-a.yml', nome: 'Deploy A' })
  })
})
