import { expect, describe, vi, beforeEach, test } from 'vitest'
import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import { loadEnv } from '../config/env.js'
import { registerPlugins } from '../plugins/index.js'
import { contaDoDevRoutes } from './conta-do-dev.js'
import { decryptCredential } from '../lib/credential-crypto.js'
import { identidadeDaConta } from '../services/credencial-do-dev-do-cliente.js'

describe('BYOK: o cliente conecta a própria conta do dev assíncrono', () => {
  let app: ReturnType<typeof Fastify>
  let authHeaders: { authorization: string }

  beforeEach(async () => {
    app = Fastify()
    const env = loadEnv()
    await registerPlugins(app, env)
    await contaDoDevRoutes(app)
    const token = jwt.sign({ userId: 'user_123', wingId: 'wing_123' }, env.JWT_SECRET)
    authHeaders = { authorization: `Bearer ${token}` }
    await app.ready()
  })

  test('a chave colada é GUARDADA CIFRADA e a identidade da conta vai junto', async () => {
    app.prisma.project.findFirst = vi.fn().mockResolvedValue({ id: 'proj_1', wingId: 'wing_123' })
    const update = vi.fn().mockResolvedValue({ id: 'proj_1' })
    app.prisma.project.update = update

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/proj_1/conta-do-dev',
      headers: authHeaders,
      payload: { apiKey: 'chave-do-cliente-abc' },
    })

    expect(res.statusCode).toBe(200)
    const data = update.mock.calls[0]![0].data
    // Nunca em texto puro no banco.
    expect(data.encryptedDevApiKey).not.toContain('chave-do-cliente-abc')
    // E o que foi guardado tem que abrir de volta na chave certa.
    expect(decryptCredential(data.encryptedDevApiKey)).toBe('chave-do-cliente-abc')
    expect(data.devAccountId).toBe(identidadeDaConta('chave-do-cliente-abc'))
  })

  test('a resposta NUNCA devolve a chave — só o estado e a identidade da conta', async () => {
    app.prisma.project.findFirst = vi.fn().mockResolvedValue({ id: 'proj_1', wingId: 'wing_123' })
    app.prisma.project.update = vi.fn().mockResolvedValue({ id: 'proj_1' })

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/proj_1/conta-do-dev',
      headers: authHeaders,
      payload: { apiKey: 'chave-do-cliente-abc' },
    })

    expect(res.body).not.toContain('chave-do-cliente-abc')
    expect(res.json()).toEqual({
      conectada: true,
      conta: identidadeDaConta('chave-do-cliente-abc'),
    })
  })

  test('chave vazia é recusada na porta', async () => {
    app.prisma.project.findFirst = vi.fn().mockResolvedValue({ id: 'proj_1', wingId: 'wing_123' })
    const update = vi.fn()
    app.prisma.project.update = update

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/proj_1/conta-do-dev',
      headers: authHeaders,
      payload: { apiKey: '   ' },
    })

    expect(res.statusCode).toBe(400)
    expect(update).not.toHaveBeenCalled()
  })

  test('projeto de OUTRO dono não é alcançável — 404, sem tocar o banco', async () => {
    app.prisma.project.findFirst = vi.fn().mockResolvedValue(null)
    const update = vi.fn()
    app.prisma.project.update = update

    const res = await app.inject({
      method: 'PUT',
      url: '/api/projects/proj_alheio/conta-do-dev',
      headers: authHeaders,
      payload: { apiKey: 'chave' },
    })

    expect(res.statusCode).toBe(404)
    expect(update).not.toHaveBeenCalled()
  })

  test('GET diz se está conectada sem jamais mostrar a chave', async () => {
    app.prisma.project.findFirst = vi.fn().mockResolvedValue({
      id: 'proj_1',
      wingId: 'wing_123',
      encryptedDevApiKey: 'envelope-cifrado',
      devAccountId: 'conta-abc123',
    })

    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/proj_1/conta-do-dev',
      headers: authHeaders,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ conectada: true, conta: 'conta-abc123' })
    expect(res.body).not.toContain('envelope-cifrado')
  })

  test('DELETE desconecta e o projeto volta para a conta da instância', async () => {
    app.prisma.project.findFirst = vi.fn().mockResolvedValue({ id: 'proj_1', wingId: 'wing_123' })
    const update = vi.fn().mockResolvedValue({ id: 'proj_1' })
    app.prisma.project.update = update

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/projects/proj_1/conta-do-dev',
      headers: authHeaders,
    })

    expect(res.statusCode).toBe(200)
    expect(update.mock.calls[0]![0].data).toEqual({
      encryptedDevApiKey: null,
      devAccountId: null,
    })
    expect(res.json()).toEqual({ conectada: false })
  })
})
