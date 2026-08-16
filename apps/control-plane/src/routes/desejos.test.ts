import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { desejosRoutes, type DependenciasDeDesejos } from './desejos.js'
import { LIMITE_DO_TEXTO_DO_DESEJO } from '../services/desejo.js'

// Cada teste declara só a dependência que o caso realmente exercita; o resto
// cai num padrão inofensivo. Sem isso, acrescentar uma dependência nova
// obrigaria a reescrever todos os testes já existentes por motivo nenhum.
function appDeTeste(deps: Partial<DependenciasDeDesejos>, linhas?: string[]) {
  const completas: DependenciasDeDesejos = {
    buscarProjeto: async () => ({ id: 'p1', githubRepo: 'dono/repo' }),
    listarProjetos: async () => [],
    buscarAutor: async () => null,
    criarIssue: async () => ({ numero: 1 }),
    ...deps,
  }
  const app = Fastify(
    linhas
      ? {
          logger: {
            level: 'error',
            stream: {
              write: (linha: string) => {
                linhas.push(linha)
              },
            },
          },
        }
      : {}
  )
  // O app real declara `request.user` como `UserPayload | undefined`; decorar
  // com `undefined` cria a propriedade sem mentir sobre o tipo.
  app.decorateRequest('user', undefined)
  app.addHook('preHandler', (req, _reply, done) => {
    ;(req as unknown as { user: unknown }).user = { id: 'u1' }
    done()
  })
  app.register(desejosRoutes, completas)
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

  it('o motivo da falha sobrevive no log — sem ele ninguém conserta nada', async () => {
    // O pino só sabe serializar um Error sob a chave `err`. Sob qualquer outra
    // chave o objeto vira `{}` e a linha de log fica sem motivo nenhum: o
    // produto registra "falhou" e some com o porquê.
    const linhas: string[] = []
    const app = appDeTeste(
      {
        buscarProjeto: vi.fn().mockResolvedValue(projeto),
        criarIssue: vi.fn().mockRejectedValue(new Error('repositório em formato inesperado')),
      },
      linhas
    )
    await app.inject({
      method: 'POST',
      url: '/api/v1/desejos',
      payload: { projectId: 'p1', texto: 'oi' },
    })
    expect(linhas.join('\n')).toContain('repositório em formato inesperado')
  })

  // A issue é o registro OFICIAL, e ela sai daqui assinada. Enquanto esta porta
  // assinava com o identificador interno do banco, o mesmo pedido nascia
  // "Pedido por: Guilherme Souza (@guilherme)" pelo mensageiro e
  // "Pedido por: clx3k9f0a0001abcd" pela tela — ilegível para quem vai ler, e,
  // num repositório público, um dado interno do produto publicado à toa.
  it('assina a issue com o nome de quem pediu, não com o identificador do banco', async () => {
    const criarIssue = vi.fn().mockResolvedValue({ numero: 5 })
    const app = appDeTeste({
      buscarAutor: vi.fn().mockResolvedValue({ nome: 'Guilherme Souza', arroba: 'guilherme' }),
      criarIssue,
    })
    await app.inject({
      method: 'POST',
      url: '/api/v1/desejos',
      payload: { projectId: 'p1', texto: 'quero busca por cor' },
    })
    const corpo = criarIssue.mock.calls[0]?.[0].corpo as string
    expect(corpo).toContain('Pedido por: Guilherme Souza (@guilherme)')
    expect(corpo).not.toContain('u1')
  })

  it('sem nome nem usuário no cadastro, ainda assina com algo — nunca em branco', async () => {
    const criarIssue = vi.fn().mockResolvedValue({ numero: 5 })
    const app = appDeTeste({ buscarAutor: vi.fn().mockResolvedValue(null), criarIssue })
    await app.inject({
      method: 'POST',
      url: '/api/v1/desejos',
      payload: { projectId: 'p1', texto: 'quero busca por cor' },
    })
    expect(criarIssue.mock.calls[0]?.[0].corpo).toContain('Pedido por: u1')
  })

  // O teto vivia só no navegador. Qualquer outro cliente da API — ou o próprio
  // painel com o `maxLength` removido pelo inspetor — mandava um texto acima do
  // teto de 65.536 do corpo de uma issue: o GitHub recusava com 422, a rota
  // devolvia 502, e a tela aconselhava "tente de novo em instantes" — conselho
  // que NUNCA ia funcionar, por mais vezes que a pessoa tentasse.
  it('recusa texto acima do teto do GitHub sem chamar o GitHub, dizendo o motivo real', async () => {
    const criarIssue = vi.fn()
    const app = appDeTeste({ criarIssue })
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/desejos',
      payload: { projectId: 'p1', texto: 'a'.repeat(LIMITE_DO_TEXTO_DO_DESEJO + 1) },
    })
    expect(r.statusCode).toBe(413)
    expect(r.json().limite).toBe(LIMITE_DO_TEXTO_DO_DESEJO)
    expect(criarIssue).not.toHaveBeenCalled()
  })

  it('texto exatamente no limite ainda é aceito', async () => {
    const criarIssue = vi.fn().mockResolvedValue({ numero: 9 })
    const app = appDeTeste({ criarIssue })
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/desejos',
      payload: { projectId: 'p1', texto: 'a'.repeat(LIMITE_DO_TEXTO_DO_DESEJO) },
    })
    expect(r.statusCode).toBe(201)
    expect(criarIssue).toHaveBeenCalled()
  })
})

// A tela precisa oferecer EXATAMENTE os projetos que o servidor aceita. Sem uma
// rota própria, ela deduzia a lista da tela de setup (filtrada por dono e por
// missão de setup, sem olhar se o projeto está ativo) enquanto o POST exigia
// projeto ativo: a tela oferecia um projeto e, no clique, dizia que aquele
// mesmo projeto "não está disponível" — e escondia projeto criado por outro
// caminho, que o servidor teria aceitado.
describe('GET /api/v1/desejos/projetos', () => {
  it('devolve os projetos que aceitam pedido, pela MESMA regra do POST', async () => {
    const listarProjetos = vi
      .fn()
      .mockResolvedValue([{ id: 'p1', nome: 'Loja', repo: 'dono/loja' }])
    const app = appDeTeste({ listarProjetos })
    const r = await app.inject({ method: 'GET', url: '/api/v1/desejos/projetos' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ projetos: [{ id: 'p1', nome: 'Loja', repo: 'dono/loja' }] })
    expect(listarProjetos).toHaveBeenCalledWith('u1')
  })

  it('dono sem projeto nenhum recebe lista vazia — que é um fato, não um erro', async () => {
    const app = appDeTeste({ listarProjetos: vi.fn().mockResolvedValue([]) })
    const r = await app.inject({ method: 'GET', url: '/api/v1/desejos/projetos' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ projetos: [] })
  })

  it('sem sessão não lista projeto de ninguém', async () => {
    const listarProjetos = vi.fn()
    const app = Fastify()
    app.decorateRequest('user', undefined)
    app.register(desejosRoutes, {
      buscarProjeto: async () => null,
      listarProjetos,
      buscarAutor: async () => null,
      criarIssue: async () => ({ numero: 1 }),
    })
    const r = await app.inject({ method: 'GET', url: '/api/v1/desejos/projetos' })
    expect(r.statusCode).toBe(401)
    expect(listarProjetos).not.toHaveBeenCalled()
  })
})
