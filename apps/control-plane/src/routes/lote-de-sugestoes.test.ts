import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { loteDeSugestoesRoutes, type DependenciasDoLoteDeSugestoes } from './lote-de-sugestoes.js'
import type { ResultadoDoDiagnostico } from '../services/diagnostico-de-issues.js'

const projeto = { id: 'p1', githubRepo: 'dono/repo', autonomia: 'sugerir' as string | null }

// Mesmo padrão de desejos.test.ts: cada teste só declara a dependência que o
// caso exercita; o resto cai num padrão inofensivo, sem chamada de rede.
function appDeTeste(deps: Partial<DependenciasDoLoteDeSugestoes>) {
  const completas: DependenciasDoLoteDeSugestoes = {
    buscarProjeto: async () => projeto,
    garantirWorkspace: async () => '/tmp/workspace-de-teste',
    listarIssuesAbertas: async () => [],
    diagnosticar: async (): Promise<ResultadoDoDiagnostico> => ({ achados: [] }),
    fecharIssue: async () => undefined,
    ...deps,
  }
  const app = Fastify()
  app.decorateRequest('user', undefined)
  app.addHook('preHandler', (req, _reply, done) => {
    ;(req as unknown as { user: unknown }).user = { id: 'u1' }
    done()
  })
  app.register(loteDeSugestoesRoutes, completas)
  return app
}

const achadoJaResolvido = {
  issue: 10,
  categoria: 'ja_resolvido' as const,
  motivo: 'o código já resolve isto',
}
const achadoRisco = { issue: 11, categoria: 'risco' as const, motivo: 'menciona senha' }

describe('GET /api/v1/projetos/:projectId/lote-de-sugestoes', () => {
  it('monta o lote com os achados do diagnóstico, numa resposta só', async () => {
    const app = appDeTeste({
      diagnosticar: async () => ({ achados: [achadoJaResolvido, achadoRisco] }),
    })
    const r = await app.inject({ method: 'GET', url: '/api/v1/projetos/p1/lote-de-sugestoes' })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.itens).toHaveLength(2)
    expect(body.itens[0]).toMatchObject({ issue: 10, categoria: 'ja_resolvido', acao: 'fechar' })
    expect(body.totalDeAchados).toBe(2)
    expect(body.foraDoTeto).toBe(0)
    expect(body.nivelDeAutonomia).toBe('sugerir')
  })

  it('projeto que não é do usuário: 404, sem tocar em workspace/GitHub', async () => {
    const garantirWorkspace = vi.fn()
    const app = appDeTeste({ buscarProjeto: async () => null, garantirWorkspace })
    const r = await app.inject({ method: 'GET', url: '/api/v1/projetos/p1/lote-de-sugestoes' })
    expect(r.statusCode).toBe(404)
    expect(garantirWorkspace).not.toHaveBeenCalled()
  })

  it('sem sessão: 401', async () => {
    const app = Fastify()
    app.decorateRequest('user', undefined)
    app.register(loteDeSugestoesRoutes, {
      buscarProjeto: async () => projeto,
      garantirWorkspace: async () => '/tmp/x',
      listarIssuesAbertas: async () => [],
      diagnosticar: async () => ({ achados: [] }),
      fecharIssue: async () => undefined,
    })
    const r = await app.inject({ method: 'GET', url: '/api/v1/projetos/p1/lote-de-sugestoes' })
    expect(r.statusCode).toBe(401)
  })

  it('lote maior que o teto: corta e reporta foraDoTeto, nunca em silêncio', async () => {
    const achados = Array.from({ length: 30 }, (_, i) => ({
      issue: i + 1,
      categoria: 'risco' as const,
      motivo: 'x',
    }))
    const app = appDeTeste({ diagnosticar: async () => ({ achados }), teto: 25 })
    const r = await app.inject({ method: 'GET', url: '/api/v1/projetos/p1/lote-de-sugestoes' })
    const body = r.json()
    expect(body.itens).toHaveLength(25)
    expect(body.totalDeAchados).toBe(30)
    expect(body.foraDoTeto).toBe(5)
  })

  it('grafo indisponível: a resposta diz o motivo, não finge que checou tudo', async () => {
    const app = appDeTeste({
      diagnosticar: async () => ({ achados: [], grafoIndisponivel: 'graphify extract falhou' }),
    })
    const r = await app.inject({ method: 'GET', url: '/api/v1/projetos/p1/lote-de-sugestoes' })
    expect(r.json().grafoIndisponivel).toBe('graphify extract falhou')
  })
})

describe('POST /api/v1/projetos/:projectId/lote-de-sugestoes/aval', () => {
  it('aprovar_tudo: aplica o lote inteiro (nível "sugerir" libera fechar/juntar)', async () => {
    const fecharIssue = vi.fn(async () => undefined)
    const app = appDeTeste({
      diagnosticar: async () => ({ achados: [achadoJaResolvido, achadoRisco] }),
      fecharIssue,
    })
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/projetos/p1/lote-de-sugestoes/aval',
      payload: { modo: 'aprovar_tudo' },
    })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body.aplicados).toBe(1) // só o 'fechar' escreve; 'risco' é sinalizar
    expect(fecharIssue).toHaveBeenCalledTimes(1)
    expect(fecharIssue).toHaveBeenCalledWith('dono/repo', 10, expect.any(String))
  })

  it('recusar_tudo: nada é aplicado, fecharIssue nunca é chamado', async () => {
    const fecharIssue = vi.fn(async () => undefined)
    const app = appDeTeste({
      diagnosticar: async () => ({ achados: [achadoJaResolvido] }),
      fecharIssue,
    })
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/projetos/p1/lote-de-sugestoes/aval',
      payload: { modo: 'recusar_tudo' },
    })
    expect(r.json().aplicados).toBe(0)
    expect(fecharIssue).not.toHaveBeenCalled()
  })

  it('por_item: só o item aprovado explicitamente é aplicado', async () => {
    const fecharIssue = vi.fn(async () => undefined)
    const outroJaResolvido = { issue: 12, categoria: 'ja_resolvido' as const, motivo: 'y' }
    const app = appDeTeste({
      diagnosticar: async () => ({ achados: [achadoJaResolvido, outroJaResolvido] }),
      fecharIssue,
    })
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/projetos/p1/lote-de-sugestoes/aval',
      payload: { modo: 'por_item', porItem: { '10': 'aprovado' } },
    })
    expect(r.json().aplicados).toBe(1)
    expect(fecharIssue).toHaveBeenCalledWith('dono/repo', 10, expect.any(String))
  })

  it('nível "so_olhar": aprovar_tudo não aplica nada — a guarda vale mesmo com aval', async () => {
    const fecharIssue = vi.fn(async () => undefined)
    const app = appDeTeste({
      buscarProjeto: async () => ({ ...projeto, autonomia: 'so_olhar' }),
      diagnosticar: async () => ({ achados: [achadoJaResolvido] }),
      fecharIssue,
    })
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/projetos/p1/lote-de-sugestoes/aval',
      payload: { modo: 'aprovar_tudo' },
    })
    expect(r.json().aplicados).toBe(0)
    expect(fecharIssue).not.toHaveBeenCalled()
  })

  it('modo inválido: 400, sem tocar em workspace/GitHub', async () => {
    const garantirWorkspace = vi.fn()
    const app = appDeTeste({ garantirWorkspace })
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/projetos/p1/lote-de-sugestoes/aval',
      payload: { modo: 'aprovar_metade' },
    })
    expect(r.statusCode).toBe(400)
    expect(garantirWorkspace).not.toHaveBeenCalled()
  })

  it('projeto que não é do usuário: 404', async () => {
    const app = appDeTeste({ buscarProjeto: async () => null })
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/projetos/p1/lote-de-sugestoes/aval',
      payload: { modo: 'aprovar_tudo' },
    })
    expect(r.statusCode).toBe(404)
  })
})
