import { describe, expect, test } from 'vitest'
import { resolveRuntimeChain, resolvePrimaryRuntime, isFailoverError } from './runtime-resolver.js'
import type { ResolverDefaults } from './runtime-resolver.js'

const defaults: ResolverDefaults = {
  runtimeByRole: { po: 'antigravity', ra: 'antigravity', sm: 'antigravity', qa: 'antigravity' },
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
    // O modelo NÃO é mais carimbado aqui. Até 01/09/2026 este degrau saía com
    // `{ runtime: 'codex', model: 'flash' }` — o modelo do Antigravity colado
    // no codex, porque `modelByRole` era uma constante só. Medido com os
    // padrões reais do scheduler, os três degraus vinham com `Gemini 3.7 Flash
    // (Medium)`, e `claude --model "Gemini 3.7 Flash (Medium)"` responde
    // "There's an issue with the selected model". Degrau sem `model` quer
    // dizer "ainda não sei": quem responde é o padrão do papel NAQUELE motor,
    // resolvido contra o catálogo vivo dele (services/padrao-do-degrau.ts).
    expect(chain[0]).toEqual({ runtime: 'codex' })
  })

  test('o esforço do degrau viaja junto com o motor e o modelo', () => {
    const cfg = {
      agents: {
        qa: {
          runtime: 'claude',
          model: 'Claude Opus 5',
          effort: 'high',
          fallbacks: [{ runtime: 'codex', model: 'GPT-5.5', effort: 'xhigh' }],
        },
      },
    }
    expect(resolveRuntimeChain('qa', cfg, defaults)).toEqual([
      { runtime: 'claude', model: 'Claude Opus 5', effort: 'high' },
      { runtime: 'codex', model: 'GPT-5.5', effort: 'xhigh' },
      { runtime: 'antigravity' },
    ])
  })

  test('descarta runtime inválido e não duplica motor', () => {
    const cfg = {
      agents: { sm: { runtime: 'invalido', fallbacks: [{ runtime: 'antigravity' }] } },
    }
    const chain = resolveRuntimeChain('sm', cfg, defaults)
    expect(chain.map((c) => c.runtime)).toEqual(['antigravity'])
  })

  test('sem config cai no MOTOR default do papel — e sem inventar modelo', () => {
    const chain = resolveRuntimeChain('qa', undefined, defaults)
    expect(chain).toEqual([{ runtime: 'antigravity' }])
  })

  test('resolvePrimaryRuntime devolve a primeira seleção', () => {
    const cfg = { agents: { po: { runtime: 'codex' } } }
    expect(resolvePrimaryRuntime('po', cfg, defaults)).toEqual({ runtime: 'codex' })
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

  // Achado importante: prompt como argumento de linha de comando estourava
  // E2BIG em repositório grande e NENHUM failover era tentado — o erro é do
  // processo local (limite do SO), não do motor, então o próximo motor da
  // cadeia do cliente merece a chance.
  test('dispara em E2BIG (achado importante: prompt gigante como argumento)', () => {
    for (const m of ['spawn agy E2BIG', 'Error: spawn E2BIG', 'execvp: Argument list too long']) {
      expect(isFailoverError(m)).toBe(true)
    }
  })
})
