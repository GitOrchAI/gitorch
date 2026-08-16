import { describe, expect, it, vi } from 'vitest'
import { acompanharPublicacao } from './publicacao.js'

const mecanismoWorkflow = { tipo: 'workflow', arquivo: 'cd.yml', nome: 'CD' } as const

describe('acompanharPublicacao', () => {
  it('mescla sem publicação nenhuma: diz que não há, e não inventa', async () => {
    const v = await acompanharPublicacao({
      mecanismo: { tipo: 'nenhum' },
      shaDaMescla: 'abc123',
      lerExecucoes: vi.fn(),
      lerEtapas: vi.fn(),
      lerPublicacoes: vi.fn(),
      lerEstadosDaPublicacao: vi.fn(),
    })
    expect(v.estado).toBe('sem-publicacao')
  })

  it('a publicação é de OUTRO commit: acusa, não diz que está no ar', async () => {
    const v = await acompanharPublicacao({
      mecanismo: mecanismoWorkflow,
      shaDaMescla: 'abc123',
      lerExecucoes: vi
        .fn()
        .mockResolvedValue([
          { id: 9, head_sha: 'antigo99', status: 'completed', conclusion: 'success' },
        ]),
      lerEtapas: vi.fn(),
      lerPublicacoes: vi.fn(),
      lerEstadosDaPublicacao: vi.fn(),
    })
    expect(v.estado).toBe('commit-errado')
    expect(v.motivo).toMatch(/outro commit|antigo/i)
  })

  it('ainda rodando: publicando', async () => {
    const v = await acompanharPublicacao({
      mecanismo: mecanismoWorkflow,
      shaDaMescla: 'abc123',
      lerExecucoes: vi
        .fn()
        .mockResolvedValue([
          { id: 9, head_sha: 'abc123', status: 'in_progress', conclusion: null },
        ]),
      lerEtapas: vi.fn().mockResolvedValue([
        { name: 'Deploy staging', status: 'completed', conclusion: 'success' },
        { name: 'Deploy backend prod', status: 'in_progress', conclusion: null },
      ]),
      lerPublicacoes: vi.fn(),
      lerEstadosDaPublicacao: vi.fn(),
    })
    expect(v.estado).toBe('publicando')
  })

  it('terminou com sucesso: no ar, com as etapas na ordem', async () => {
    const v = await acompanharPublicacao({
      mecanismo: mecanismoWorkflow,
      shaDaMescla: 'abc123',
      lerExecucoes: vi
        .fn()
        .mockResolvedValue([
          { id: 9, head_sha: 'abc123', status: 'completed', conclusion: 'success' },
        ]),
      lerEtapas: vi.fn().mockResolvedValue([
        { name: 'Deploy staging', status: 'completed', conclusion: 'success' },
        { name: 'Smoke staging', status: 'completed', conclusion: 'success' },
        { name: 'Deploy frontend prod', status: 'completed', conclusion: 'success' },
        { name: 'Smoke gate produção', status: 'completed', conclusion: 'success' },
        { name: 'Rollback backend', status: 'completed', conclusion: 'skipped' },
      ]),
      lerPublicacoes: vi.fn(),
      lerEstadosDaPublicacao: vi.fn(),
    })
    expect(v.estado).toBe('no-ar')
    expect(v.etapas.map((e) => e.nome)).toContain('Smoke gate produção')
  })

  it('uma etapa de publicação falhou: falhou, mesmo com o conjunto verde', async () => {
    const v = await acompanharPublicacao({
      mecanismo: mecanismoWorkflow,
      shaDaMescla: 'abc123',
      lerExecucoes: vi
        .fn()
        .mockResolvedValue([
          { id: 9, head_sha: 'abc123', status: 'completed', conclusion: 'success' },
        ]),
      lerEtapas: vi.fn().mockResolvedValue([
        { name: 'Deploy staging', status: 'completed', conclusion: 'success' },
        { name: 'Deploy backend prod', status: 'completed', conclusion: 'failure' },
      ]),
      lerPublicacoes: vi.fn(),
      lerEstadosDaPublicacao: vi.fn(),
    })
    expect(v.estado).toBe('falhou')
  })

  it('pelo mecanismo de deployment: usa o estado mais novo e traz o endereço', async () => {
    const v = await acompanharPublicacao({
      mecanismo: { tipo: 'deployment', ambientes: ['github-pages'] },
      shaDaMescla: 'abc123',
      lerPublicacoes: vi
        .fn()
        .mockResolvedValue([{ id: 5, environment: 'github-pages', sha: 'abc123' }]),
      lerEstadosDaPublicacao: vi.fn().mockResolvedValue([
        {
          state: 'success',
          environment_url: 'https://exemplo.test/',
          created_at: '2026-08-16T10:00:00Z',
        },
        { state: 'in_progress', environment_url: '', created_at: '2026-08-16T09:59:00Z' },
      ]),
      lerExecucoes: vi.fn(),
      lerEtapas: vi.fn(),
    })
    expect(v.estado).toBe('no-ar')
    expect(v.enderecos).toContain('https://exemplo.test/')
  })

  it('publicação que virou inativa não conta como no ar', async () => {
    const v = await acompanharPublicacao({
      mecanismo: { tipo: 'deployment', ambientes: ['github-pages'] },
      shaDaMescla: 'abc123',
      lerPublicacoes: vi
        .fn()
        .mockResolvedValue([{ id: 5, environment: 'github-pages', sha: 'abc123' }]),
      lerEstadosDaPublicacao: vi
        .fn()
        .mockResolvedValue([
          { state: 'inactive', environment_url: '', created_at: '2026-08-16T10:00:00Z' },
        ]),
      lerExecucoes: vi.fn(),
      lerEtapas: vi.fn(),
    })
    expect(v.estado).not.toBe('no-ar')
  })
})
