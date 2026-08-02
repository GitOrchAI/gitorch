import { describe, it, expect, afterEach } from 'vitest'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { parseRateLimitAllowList } from './rate-limit-keys.js'
import { resetEnvCache } from '../config/env.js'
import { buildApp } from '../index.js'

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

// Achados I1/M2: a suíte acima constrói SEU PRÓPRIO Fastify com
// `trustProxy: true` cru — nunca observa o wiring real de produção
// (`trustProxy: env.GITORCH_TRUST_PROXY ? 1 : false` em src/index.ts, e
// `allowList: parseRateLimitAllowList(...)` em plugins/index.ts). Apagar
// qualquer uma das duas linhas reais deixava a suíte acima 100% verde —
// prova nenhuma de que a app de verdade está protegida. Os testes abaixo
// usam `buildApp()` (o MESMO caminho que src/index.ts usa pra subir o
// servidor de produção) pra observar o wiring de verdade — têm que ficar
// vermelhos se qualquer uma das duas linhas for removida (provado por
// mutação ao escrever este teste).
describe('integração REAL: buildApp() — wiring de produção de trustProxy e allowList', () => {
  afterEach(async () => {
    resetEnvCache()
    delete process.env['GITORCH_TRUST_PROXY']
    delete process.env['GITORCH_RATE_LIMIT_ALLOWLIST']
    delete process.env['RATE_LIMIT_MAX']
  })

  it('achado I1: trustProxy real confia só 1 hop — o cliente NÃO controla o IP resolvido prefixando o X-Forwarded-For', async () => {
    process.env['GITORCH_TRUST_PROXY'] = '1'
    resetEnvCache()
    const app = await buildApp()
    // Rota de sonda só pra ler request.ip resolvido pelo wiring real do
    // trustProxy — nada no app "de produção" expõe isso diretamente.
    app.get('/__test-resolved-ip', async (req) => ({ ip: req.ip }))

    const spoofed = await app.inject({
      url: '/__test-resolved-ip',
      // O cliente tenta se passar por outro IP prefixando a cadeia; só a
      // ÚLTIMA entrada (a que um proxy real, o Funnel, teria anexado) é
      // confiada com trustProxy:1.
      headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' },
    })
    expect(spoofed.json()).toEqual({ ip: '203.0.113.7' })
    await app.close()
  })

  it('achado M2: allowList real isenta o IP configurado e NÃO isenta um IP fora dela — prova as duas linhas de wiring de uma vez (trustProxy resolve o IP certo, allowList decide quem é isento)', async () => {
    process.env['GITORCH_TRUST_PROXY'] = '1'
    process.env['GITORCH_RATE_LIMIT_ALLOWLIST'] = '203.0.113.9'
    process.env['RATE_LIMIT_MAX'] = '1'
    resetEnvCache()
    const app = await buildApp()
    app.get('/__test-rl', async () => ({ ok: true }))

    const allowedHeaders = { 'x-forwarded-for': '203.0.113.9' }
    const blockedHeaders = { 'x-forwarded-for': '203.0.113.10' }

    // IP na allowlist: passa do max=1 sem nunca ser limitado.
    await app.inject({ url: '/__test-rl', headers: allowedHeaders })
    const stillOk = await app.inject({ url: '/__test-rl', headers: allowedHeaders })
    expect(stillOk.statusCode).toBe(200)

    // IP FORA da allowlist: respeita o max=1 normalmente.
    await app.inject({ url: '/__test-rl', headers: blockedHeaders })
    const blocked = await app.inject({ url: '/__test-rl', headers: blockedHeaders })
    expect(blocked.statusCode).toBe(429)

    await app.close()
  })

  // Achado FW-3: `trustProxy` real é uma LISTA de peers confiáveis
  // (['127.0.0.1', '::1'] — o Funnel roda local), não uma CONTAGEM de hops.
  // Com contagem, `request.ip` confiaria em X-Forwarded-For não importa QUEM
  // conectou de verdade na porta — qualquer processo na mesma VM/rede
  // privada que alcance a porta DIRETO (pulando o Funnel de propósito) podia
  // escrever seu próprio X-Forwarded-For e ser obedecido do mesmo jeito,
  // girando o balde do rate limit à vontade. Este teste conecta como um peer
  // NÃO-confiável (remoteAddress fora de 127.0.0.1/::1, o "socket" real que
  // o light-my-request simula) e prova que o X-Forwarded-For forjado é
  // completamente ignorado — `request.ip` cai pro peer real da conexão.
  it('achado FW-3: peer NÃO-confiável (conexão direta, não o proxy local) não controla o IP resolvido via X-Forwarded-For forjado', async () => {
    process.env['GITORCH_TRUST_PROXY'] = '1'
    resetEnvCache()
    const app = await buildApp()
    app.get('/__test-resolved-ip', async (req) => ({ ip: req.ip }))

    const attackerDirectConnect = await app.inject({
      url: '/__test-resolved-ip',
      // Simula um processo que fala DIRETO com a porta da API (não passa
      // pelo Funnel/proxy local) tentando se passar por outro cliente via
      // header forjado.
      remoteAddress: '203.0.113.50',
      headers: { 'x-forwarded-for': '6.6.6.6, 9.9.9.9' },
    })
    // O peer real da conexão NÃO está na lista de confiança
    // (['127.0.0.1', '::1']) — o cabeçalho inteiro é ignorado, `request.ip`
    // é o peer real, nunca uma das entradas forjadas do header.
    expect(attackerDirectConnect.json()).toEqual({ ip: '203.0.113.50' })

    await app.close()
  })
})
