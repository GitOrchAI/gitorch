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

  // FINDING 1 — o veredito segue produção, não o pior estado entre todos os
  // ambientes: um staging vermelho não pode esconder uma produção no ar, e
  // uma produção vermelha não pode ser escondida por um staging verde.
  it('produção no ar com staging falhando: no ar, e a falha do staging continua visível', async () => {
    const v = await acompanharPublicacao({
      mecanismo: { tipo: 'deployment', ambientes: ['staging', 'production'] },
      shaDaMescla: 'abc123',
      lerPublicacoes: vi.fn().mockImplementation(async (ambiente: string) =>
        ambiente === 'production'
          ? [
              {
                id: 6,
                environment: 'production',
                sha: 'abc123',
                production_environment: true,
                transient_environment: false,
              },
            ]
          : [
              {
                id: 5,
                environment: 'staging',
                sha: 'abc123',
                production_environment: false,
                transient_environment: false,
              },
            ]
      ),
      lerEstadosDaPublicacao: vi.fn().mockImplementation(async (id: number) =>
        id === 6
          ? [
              {
                state: 'success',
                environment_url: 'https://prod.exemplo.test/',
                created_at: '2026-08-16T10:00:00Z',
              },
            ]
          : [{ state: 'failure', environment_url: '', created_at: '2026-08-16T09:55:00Z' }]
      ),
      lerExecucoes: vi.fn(),
      lerEtapas: vi.fn(),
    })
    expect(v.estado).toBe('no-ar')
    expect(v.enderecos).toContain('https://prod.exemplo.test/')
    const etapaDoStaging = v.etapas.find((e) => e.nome === 'Publicação em staging')
    expect(etapaDoStaging?.resultado).toBe('failure')
  })

  it('produção falhando com staging no ar: falhou (o inverso não pode ser escondido)', async () => {
    const v = await acompanharPublicacao({
      mecanismo: { tipo: 'deployment', ambientes: ['staging', 'production'] },
      shaDaMescla: 'abc123',
      lerPublicacoes: vi.fn().mockImplementation(async (ambiente: string) =>
        ambiente === 'production'
          ? [
              {
                id: 6,
                environment: 'production',
                sha: 'abc123',
                production_environment: true,
                transient_environment: false,
              },
            ]
          : [
              {
                id: 5,
                environment: 'staging',
                sha: 'abc123',
                production_environment: false,
                transient_environment: false,
              },
            ]
      ),
      lerEstadosDaPublicacao: vi.fn().mockImplementation(async (id: number) =>
        id === 6
          ? [{ state: 'failure', environment_url: '', created_at: '2026-08-16T10:00:00Z' }]
          : [
              {
                state: 'success',
                environment_url: 'https://staging.exemplo.test/',
                created_at: '2026-08-16T09:55:00Z',
              },
            ]
      ),
      lerExecucoes: vi.fn(),
      lerEtapas: vi.fn(),
    })
    expect(v.estado).toBe('falhou')
  })

  it('sem informação de qual ambiente é produção: pior-vence entre todos, sem mudança', async () => {
    const v = await acompanharPublicacao({
      mecanismo: { tipo: 'deployment', ambientes: ['staging', 'preview'] },
      shaDaMescla: 'abc123',
      // Nenhuma das duas publicações declara `production_environment: true`
      // — não dá para saber qual ambiente é produção, então o comportamento
      // antigo (pior-vence geral) deve continuar valendo.
      lerPublicacoes: vi.fn().mockImplementation(async (ambiente: string) => [
        {
          id: ambiente === 'staging' ? 5 : 7,
          environment: ambiente,
          sha: 'abc123',
          production_environment: false,
          transient_environment: false,
        },
      ]),
      lerEstadosDaPublicacao: vi.fn().mockImplementation(async (id: number) =>
        id === 5
          ? [{ state: 'failure', environment_url: '', created_at: '2026-08-16T10:00:00Z' }]
          : [
              {
                state: 'success',
                environment_url: 'https://preview.exemplo.test/',
                created_at: '2026-08-16T09:55:00Z',
              },
            ]
      ),
      lerExecucoes: vi.fn(),
      lerEtapas: vi.fn(),
    })
    expect(v.estado).toBe('falhou')
  })

  // FINDING 2 — um job cujo NOME diz que publica, voltando "skipped", não é
  // prova de publicação — mesmo com o resto do conjunto verde.
  it('job que publica veio "skipped": sem prova de publicação, mesmo com o resto verde', async () => {
    const v = await acompanharPublicacao({
      mecanismo: mecanismoWorkflow,
      shaDaMescla: 'abc123',
      lerExecucoes: vi
        .fn()
        .mockResolvedValue([
          { id: 9, head_sha: 'abc123', status: 'completed', conclusion: 'success' },
        ]),
      lerEtapas: vi.fn().mockResolvedValue([
        { name: 'Build', status: 'completed', conclusion: 'success' },
        { name: 'Deploy backend prod', status: 'completed', conclusion: 'skipped' },
      ]),
      lerPublicacoes: vi.fn(),
      lerEstadosDaPublicacao: vi.fn(),
    })
    expect(v.estado).toBe('sem-publicacao')
    expect(v.motivo).toMatch(/pulad|publicação/i)
  })

  it('job de reversão pulado com "deploy" no nome continua benigno: no ar', async () => {
    const v = await acompanharPublicacao({
      mecanismo: mecanismoWorkflow,
      shaDaMescla: 'abc123',
      lerExecucoes: vi
        .fn()
        .mockResolvedValue([
          { id: 9, head_sha: 'abc123', status: 'completed', conclusion: 'success' },
        ]),
      lerEtapas: vi.fn().mockResolvedValue([
        { name: 'Deploy backend prod', status: 'completed', conclusion: 'success' },
        { name: 'Rollback do deploy', status: 'completed', conclusion: 'skipped' },
      ]),
      lerPublicacoes: vi.fn(),
      lerEstadosDaPublicacao: vi.fn(),
    })
    expect(v.estado).toBe('no-ar')
  })

  // FINDING 3 — o filtro de defesa depois da leitura (a leitura real já
  // filtra por commit, mas o código revalida): sem ele, uma leitura injetada
  // que devolvesse o commit errado seria aceita como se fosse do commit
  // certo.
  it('a leitura de publicações devolve o commit errado: o filtro de defesa barra, não conta como no ar', async () => {
    const v = await acompanharPublicacao({
      mecanismo: { tipo: 'deployment', ambientes: ['github-pages'] },
      shaDaMescla: 'abc123',
      lerPublicacoes: vi.fn().mockResolvedValue([
        {
          id: 5,
          environment: 'github-pages',
          sha: 'outro456',
          production_environment: true,
          transient_environment: false,
        },
      ]),
      lerEstadosDaPublicacao: vi.fn().mockResolvedValue([
        {
          state: 'success',
          environment_url: 'https://exemplo.test/',
          created_at: '2026-08-16T10:00:00Z',
        },
      ]),
      lerExecucoes: vi.fn(),
      lerEtapas: vi.fn(),
    })
    expect(v.estado).toBe('sem-publicacao')
    expect(v.enderecos).not.toContain('https://exemplo.test/')
  })
})
