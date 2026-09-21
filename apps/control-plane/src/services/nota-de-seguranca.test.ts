import { describe, it, expect } from 'vitest'
import { calcularNotaDeSeguranca, coletarChecksDeSeguranca } from './nota-de-seguranca.js'

describe('calcularNotaDeSeguranca', () => {
  it('todos os 6 checks passando: nota 100 sobre 6', () => {
    const r = calcularNotaDeSeguranca({
      branchProtection: true,
      actionsFixadasPorSha: true,
      permissaoPadraoDoToken: 'read',
      codeowners: true,
      securityMd: true,
      dependabotConfigurado: true,
    })
    expect(r).toEqual({ nota: 100, maximo: 6, formula: expect.any(Array) })
  })

  it('metade passando: nota 50', () => {
    const r = calcularNotaDeSeguranca({
      branchProtection: true,
      actionsFixadasPorSha: false,
      permissaoPadraoDoToken: 'write',
      codeowners: true,
      securityMd: false,
      dependabotConfigurado: false,
    })
    expect(r.nota).toBe(33)
  })

  it('check não verificado (null) é excluído do denominador, não conta contra', () => {
    const r = calcularNotaDeSeguranca({
      branchProtection: true,
      actionsFixadasPorSha: null,
      permissaoPadraoDoToken: 'read',
      codeowners: true,
      securityMd: true,
      dependabotConfigurado: true,
    })
    expect(r).toEqual({ nota: 100, maximo: 5, formula: expect.any(Array) })
  })

  it('nenhum check verificado: nota null, nunca 0 nem 100 inventados', () => {
    const r = calcularNotaDeSeguranca({
      branchProtection: null,
      actionsFixadasPorSha: null,
      permissaoPadraoDoToken: null,
      codeowners: null,
      securityMd: null,
      dependabotConfigurado: null,
    })
    expect(r.nota).toBeNull()
    expect(r.maximo).toBe(0)
  })
})

describe('coletarChecksDeSeguranca', () => {
  it('lê os 6 sinais reais, cada falha isolada vira null (best-effort)', async () => {
    const respostas: Record<string, { status: number; json?: unknown }> = {
      '/repos/dono/repo/branches/main/protection': {
        status: 200,
        json: { required_pull_request_reviews: {} },
      },
      '/repos/dono/repo/actions/permissions/workflow': {
        status: 200,
        json: { default_workflow_permissions: 'read' },
      },
      '/repos/dono/repo/contents/CODEOWNERS': { status: 200 },
      '/repos/dono/repo/contents/SECURITY.md': { status: 404 },
      '/repos/dono/repo/contents/.github/dependabot.yml': { status: 200 },
      '/repos/dono/repo/contents/.github/workflows': { status: 200, json: [] },
    }
    const fetchImpl = (async (url: string) => {
      const caminho = new URL(url).pathname
      const r = respostas[caminho] ?? { status: 500 }
      return new Response(r.json ? JSON.stringify(r.json) : '', { status: r.status })
    }) as typeof fetch

    const checks = await coletarChecksDeSeguranca({
      repository: 'dono/repo',
      defaultBranch: 'main',
      token: 't',
      fetchImpl,
    })
    expect(checks.branchProtection).toBe(true)
    expect(checks.permissaoPadraoDoToken).toBe('read')
    expect(checks.codeowners).toBe(true)
    expect(checks.securityMd).toBe(false)
    expect(checks.dependabotConfigurado).toBe(true)
  })
})
