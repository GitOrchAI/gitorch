import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { parseRateLimitAllowList, authRateLimitKey } from './rate-limit-keys.js'

describe('parseRateLimitAllowList', () => {
  it('divide csv e apara espaços', () => {
    expect(parseRateLimitAllowList('127.0.0.1, ::1')).toEqual(['127.0.0.1', '::1'])
  })
  it('string vazia = NENHUM allowlist (prod atrás do Funnel)', () => {
    expect(parseRateLimitAllowList('')).toEqual([])
    expect(parseRateLimitAllowList('  ')).toEqual([])
  })
})

describe('authRateLimitKey', () => {
  it('sessões diferentes no MESMO IP caem em baldes diferentes (P1-1)', () => {
    const a = authRateLimitKey({
      ip: '1.2.3.4',
      cookies: { gitorch_session: 'jwt-a' },
      headers: {},
    })
    const b = authRateLimitKey({
      ip: '1.2.3.4',
      cookies: { gitorch_session: 'jwt-b' },
      headers: {},
    })
    expect(a).not.toEqual(b)
    expect(a.startsWith('sess:')).toBe(true)
  })
  it('nunca embute o token cru na chave (vaza em header x-ratelimit)', () => {
    const k = authRateLimitKey({
      ip: '1.2.3.4',
      cookies: { gitorch_session: 'segredo-jwt' },
      headers: {},
    })
    expect(k).not.toContain('segredo-jwt')
  })
  it('Bearer sem cookie usa hash do token', () => {
    const k = authRateLimitKey({ ip: '1.2.3.4', headers: { authorization: 'Bearer abc' } })
    expect(k.startsWith('bearer:')).toBe(true)
  })
  it('sem credencial nenhuma cai no IP', () => {
    expect(authRateLimitKey({ ip: '9.9.9.9', headers: {} })).toBe('ip:9.9.9.9')
  })
})

describe('integração: trustProxy + keyGenerator por sessão', () => {
  it('com trustProxy, o IP vem do X-Forwarded-For (Funnel) e cada sessão tem contador próprio', async () => {
    const app = Fastify({ trustProxy: true })
    await app.register(import('@fastify/cookie'))
    await app.register(rateLimit, {
      max: 2,
      timeWindow: 60_000,
      keyGenerator: (req) => authRateLimitKey(req),
    })
    app.get('/t', async () => ({ ok: true }))
    const h = { 'x-forwarded-for': '203.0.113.7' }
    // sessão A esgota o próprio balde…
    await app.inject({ url: '/t', headers: { ...h, cookie: 'gitorch_session=aaa' } })
    await app.inject({ url: '/t', headers: { ...h, cookie: 'gitorch_session=aaa' } })
    const blockedA = await app.inject({
      url: '/t',
      headers: { ...h, cookie: 'gitorch_session=aaa' },
    })
    expect(blockedA.statusCode).toBe(429)
    // …sem afetar a sessão B no MESMO IP de origem
    const okB = await app.inject({ url: '/t', headers: { ...h, cookie: 'gitorch_session=bbb' } })
    expect(okB.statusCode).toBe(200)
    await app.close()
  })
})
