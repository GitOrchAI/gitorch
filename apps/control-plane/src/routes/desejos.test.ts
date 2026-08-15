import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { desejosRoutes } from './desejos.js'

function appDeTeste(deps: Parameters<typeof desejosRoutes>[1]) {
  const app = Fastify()
  // O app real declara `request.user` como `UserPayload | undefined`; decorar
  // com `undefined` cria a propriedade sem mentir sobre o tipo.
  app.decorateRequest('user', undefined)
  app.addHook('preHandler', (req, _reply, done) => {
    ;(req as unknown as { user: unknown }).user = { id: 'u1' }
    done()
  })
  app.register(desejosRoutes, deps)
  return app
}

describe('POST /api/v1/desejos', () => {
  const projeto = { id: 'p1', githubRepo: 'dono/repo' }

  it('cria a issue com a etiqueta e devolve o número', async () => {
    const criarIssue = vi.fn().mockResolvedValue({ numero: 77 })
    const app = appDeTeste({
      buscarProjeto: vi.fn().mockResolvedValue(projeto),
      criarIssue,
    })
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/desejos',
      payload: { projectId: 'p1', texto: 'quero avaliação com foto' },
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().numero).toBe(77)
    expect(criarIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'dono/repo',
        etiquetas: ['wishlist'],
        titulo: 'quero avaliação com foto',
      })
    )
  })

  it('recusa texto vazio com 400, sem chamar o GitHub', async () => {
    const criarIssue = vi.fn()
    const app = appDeTeste({ buscarProjeto: vi.fn().mockResolvedValue(projeto), criarIssue })
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/desejos',
      payload: { projectId: 'p1', texto: '   ' },
    })
    expect(r.statusCode).toBe(400)
    expect(criarIssue).not.toHaveBeenCalled()
  })

  it('recusa projeto que não é do usuário com 404', async () => {
    const app = appDeTeste({
      buscarProjeto: vi.fn().mockResolvedValue(null),
      criarIssue: vi.fn(),
    })
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/desejos',
      payload: { projectId: 'de-outro', texto: 'oi' },
    })
    expect(r.statusCode).toBe(404)
  })

  it('devolve 502 quando o GitHub recusa, sem vazar detalhe interno', async () => {
    const app = appDeTeste({
      buscarProjeto: vi.fn().mockResolvedValue(projeto),
      criarIssue: vi.fn().mockRejectedValue(new Error('token ghp_segredo inválido')),
    })
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/desejos',
      payload: { projectId: 'p1', texto: 'oi' },
    })
    expect(r.statusCode).toBe(502)
    expect(JSON.stringify(r.json())).not.toContain('ghp_')
  })
})
