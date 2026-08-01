import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { parseRateLimitAllowList } from './rate-limit-keys.js'

describe('parseRateLimitAllowList', () => {
  it('divide csv e apara espaços', () => {
    expect(parseRateLimitAllowList('127.0.0.1, ::1')).toEqual(['127.0.0.1', '::1'])
  })
  it('string vazia = NENHUM allowlist (prod atrás do Funnel)', () => {
    expect(parseRateLimitAllowList('')).toEqual([])
    expect(parseRateLimitAllowList('  ')).toEqual([])
  })
})

describe('integração: trustProxy + rate limit por IP real (Funnel)', () => {
  it('com trustProxy, o IP real vem do X-Forwarded-For: IPs diferentes têm baldes independentes, e o MESMO IP forwardado compartilha um único balde (proteção contra brute force)', async () => {
    const app = Fastify({ trustProxy: true })
    // Sem keyGenerator custom: usa o default do plugin, que chaveia por
    // request.ip — com trustProxy ligado, esse é o IP real do cliente
    // (X-Forwarded-For), não o loopback do tailscaled.
    await app.register(rateLimit, { max: 2, timeWindow: 60_000 })
    app.get('/t', async () => ({ ok: true }))
    const ipA = { 'x-forwarded-for': '203.0.113.7' }
    // IP A esgota o próprio balde: as 2 primeiras passam, a 3ª bloqueia —
    // ou seja, requisições do MESMO IP forwardado dividem um único balde.
    await app.inject({ url: '/t', headers: ipA })
    await app.inject({ url: '/t', headers: ipA })
    const blockedA = await app.inject({ url: '/t', headers: ipA })
    expect(blockedA.statusCode).toBe(429)
    // …sem afetar um IP de origem DIFERENTE (balde independente).
    const okB = await app.inject({ url: '/t', headers: { 'x-forwarded-for': '198.51.100.9' } })
    expect(okB.statusCode).toBe(200)
    await app.close()
  })
})
