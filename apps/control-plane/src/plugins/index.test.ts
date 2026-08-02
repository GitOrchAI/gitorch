import { afterEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { loadEnv, resetEnvCache } from '../config/env.js'
import { registerPlugins } from './index.js'

/**
 * Achado FW-4: o guard de má-configuração de produção (registerPlugins,
 * achado I3 da rodada anterior — "a ÚNICA combinação segura em produção
 * atrás do Funnel é trustProxy=1 E allowlist vazia") nunca tinha teste. Uma
 * rede de segurança sem teste é exatamente a mesma classe de defeito que os
 * achados FW-1/FW-2 desta rodada: pode sumir silenciosamente numa
 * refatoração futura sem NADA ficar vermelho pra avisar. Este teste prova
 * que a combinação insegura em produção realmente loga em ERROR (não warn,
 * não silencioso) — e que a combinação segura NÃO loga nada.
 *
 * Chama `registerPlugins` diretamente (não `buildApp()`/`Fastify(...)` com
 * as opções de produção) porque precisamos espiar `app.log.error` ANTES do
 * guard rodar — o guard é a PRIMEIRA coisa que `registerPlugins` faz, antes
 * de qualquer plugin real ser registrado, então dá pra montar um app mínimo,
 * grudar o spy no logger e só então chamar `registerPlugins`.
 */
describe('registerPlugins: guard de config insegura em produção (achado I3)', () => {
  afterEach(() => {
    resetEnvCache()
    delete process.env['GITORCH_TRUST_PROXY']
    delete process.env['GITORCH_RATE_LIMIT_ALLOWLIST']
    process.env['NODE_ENV'] = 'test'
    resetEnvCache()
  })

  async function registerAndCaptureErrorLog(): Promise<{
    loggedInsecure: boolean
    close: () => Promise<void>
  }> {
    const env = loadEnv()
    const app = Fastify({ logger: { level: 'silent' } })
    const errorSpy = vi.spyOn(app.log, 'error')
    await registerPlugins(app, env)
    await app.ready()
    const loggedInsecure = errorSpy.mock.calls.some((call) => String(call[0]).includes('INSEGURA'))
    return { loggedInsecure, close: () => app.close() }
  }

  it('produção + allowlist não-vazia loga em ERROR', async () => {
    process.env['NODE_ENV'] = 'production'
    process.env['GITORCH_TRUST_PROXY'] = '1'
    process.env['GITORCH_RATE_LIMIT_ALLOWLIST'] = '127.0.0.1'
    resetEnvCache()

    const { loggedInsecure, close } = await registerAndCaptureErrorLog()
    try {
      expect(loggedInsecure).toBe(true)
    } finally {
      await close()
    }
  })

  it('produção + trustProxy desligado (mesmo com allowlist vazia) loga em ERROR', async () => {
    process.env['NODE_ENV'] = 'production'
    delete process.env['GITORCH_TRUST_PROXY']
    process.env['GITORCH_RATE_LIMIT_ALLOWLIST'] = ''
    resetEnvCache()

    const { loggedInsecure, close } = await registerAndCaptureErrorLog()
    try {
      expect(loggedInsecure).toBe(true)
    } finally {
      await close()
    }
  })

  it('produção + trustProxy=1 E allowlist vazia (combinação segura) NÃO loga o achado I3', async () => {
    process.env['NODE_ENV'] = 'production'
    process.env['GITORCH_TRUST_PROXY'] = '1'
    process.env['GITORCH_RATE_LIMIT_ALLOWLIST'] = ''
    resetEnvCache()

    const { loggedInsecure, close } = await registerAndCaptureErrorLog()
    try {
      expect(loggedInsecure).toBe(false)
    } finally {
      await close()
    }
  })

  it('fora de produção, mesmo com a combinação insegura, NÃO loga o achado I3 (guard é só de produção)', async () => {
    process.env['NODE_ENV'] = 'test'
    delete process.env['GITORCH_TRUST_PROXY']
    process.env['GITORCH_RATE_LIMIT_ALLOWLIST'] = '127.0.0.1'
    resetEnvCache()

    const { loggedInsecure, close } = await registerAndCaptureErrorLog()
    try {
      expect(loggedInsecure).toBe(false)
    } finally {
      await close()
    }
  })
})
