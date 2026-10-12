import { test, expect, describe, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import { loadEnv, resetEnvCache } from '../config/env.js'
import { registerPlugins } from '../plugins/index.js'
import { versionRoutes } from './version.js'
import { limparCacheDaVersaoNoAr } from '../services/commit-publicado.js'

describe('GET /api/v1/version', () => {
  let app: ReturnType<typeof Fastify>
  const envOriginal = process.env['GITORCH_PUBLISHED_COMMIT']

  beforeEach(async () => {
    process.env['GITORCH_RATE_LIMIT_ALLOWLIST'] = ''
    resetEnvCache()
    limparCacheDaVersaoNoAr()
    app = Fastify()
    await registerPlugins(app, loadEnv())
    await versionRoutes(app)
    await app.ready()
  })

  afterEach(() => {
    delete process.env['GITORCH_RATE_LIMIT_ALLOWLIST']
    if (envOriginal === undefined) delete process.env['GITORCH_PUBLISHED_COMMIT']
    else process.env['GITORCH_PUBLISHED_COMMIT'] = envOriginal
    resetEnvCache()
    limparCacheDaVersaoNoAr()
  })

  test('é pública (sem token) e devolve nome, commit e noArDesde', async () => {
    process.env['GITORCH_PUBLISHED_COMMIT'] = '4cf295d273c91567263d972e042599b9d0dc25e7'
    const res = await app.inject({ method: 'GET', url: '/api/v1/version' })
    expect(res.statusCode).toBe(200)
    const corpo = res.json()
    expect(corpo).toEqual({
      name: 'gitorch-control-plane',
      commit: '4cf295d273c91567263d972e042599b9d0dc25e7',
      noArDesde: expect.any(String),
    })
    expect(Number.isNaN(Date.parse(corpo.noArDesde))).toBe(false)
  })

  test('sem commit publicado devolve "desconhecido", nunca inventa valor, e não traz o literal antigo', async () => {
    delete process.env['GITORCH_PUBLISHED_COMMIT']
    const res = await app.inject({ method: 'GET', url: '/api/v1/version' })
    expect(res.statusCode).toBe(200)
    expect(res.json().commit).toBe('desconhecido')
    expect(res.json()).not.toHaveProperty('version')
  })

  test('/api/v1/status continua exigindo autenticação', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/status' })
    expect(res.statusCode).toBe(401)
  })
})
