import { describe, expect, test } from 'vitest'
import { resolveRuntimeChain, resolvePrimaryRuntime, isFailoverError } from './runtime-resolver.js'
import type { ResolverDefaults } from './runtime-resolver.js'

const defaults: ResolverDefaults = {
  runtimeByRole: { po: 'antigravity', ra: 'antigravity', sm: 'antigravity', qa: 'antigravity' },
  modelByRole: { po: 'pro', ra: 'flash', sm: 'flash', qa: 'flash' },
}

describe('resolveRuntimeChain', () => {
  test('usa a preferência do cliente por agente', () => {
    const cfg = { agents: { po: { runtime: 'claude', model: 'opus' } } }
    const chain = resolveRuntimeChain('po', cfg, defaults)
    expect(chain[0]).toEqual({ runtime: 'claude', model: 'opus' })
  })

  test('monta cadeia primária + fallbacks e sempre inclui o default no fim', () => {
    const cfg = { agents: { ra: { runtime: 'codex', fallbacks: [{ runtime: 'claude' }] } } }
    const chain = resolveRuntimeChain('ra', cfg, defaults)
    expect(chain.map((c) => c.runtime)).toEqual(['codex', 'claude', 'antigravity'])
    // modelo default preenchido quando a preferência não trouxe
    expect(chain[0]).toEqual({ runtime: 'codex', model: 'flash' })
  })

  test('descarta runtime inválido e não duplica motor', () => {
    const cfg = {
      agents: { sm: { runtime: 'invalido', fallbacks: [{ runtime: 'antigravity' }] } },
    }
    const chain = resolveRuntimeChain('sm', cfg, defaults)
    expect(chain.map((c) => c.runtime)).toEqual(['antigravity'])
  })

  test('sem config cai no default do papel', () => {
    const chain = resolveRuntimeChain('qa', undefined, defaults)
    expect(chain).toEqual([{ runtime: 'antigravity', model: 'flash' }])
  })

  test('resolvePrimaryRuntime devolve a primeira seleção', () => {
    const cfg = { agents: { po: { runtime: 'codex' } } }
    expect(resolvePrimaryRuntime('po', cfg, defaults)).toEqual({ runtime: 'codex', model: 'pro' })
  })
})

describe('isFailoverError', () => {
  test('dispara em cota/rate-limit/auth', () => {
    for (const m of [
      'quota exceeded',
      'HTTP 429 rate limit',
      'insufficient_quota',
      '401 Unauthorized',
      'invalid api key',
      'Forbidden 403',
    ]) {
      expect(isFailoverError(m)).toBe(true)
    }
  })
  test('não dispara em erro comum de execução/conteúdo', () => {
    for (const m of [
      'SyntaxError in repo file',
      'timeout waiting for response',
      'file not found',
    ]) {
      expect(isFailoverError(m)).toBe(false)
    }
  })
})
