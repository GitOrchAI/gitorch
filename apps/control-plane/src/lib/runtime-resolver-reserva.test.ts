import { describe, it, expect } from 'vitest'
import { resolveRuntimeChain, type ResolverDefaults } from './runtime-resolver.js'

const DEFAULTS: ResolverDefaults = {
  runtimeByRole: { ra: 'antigravity', po: 'antigravity', sm: 'antigravity', qa: 'antigravity' },
  modelByRole: { ra: 'm', po: 'm', sm: 'm', qa: 'm' },
}
const SO_ANTIGRAVITY = { agents: { ra: { runtime: 'antigravity' } } }
const runtimes = (c: Array<{ runtime: string }>) => c.map((s) => s.runtime)

describe('a cadeia ganha reserva dos motores conectados', () => {
  it('projeto com UM motor escolhido ficava sem reserva — era isso que parava a esteira', () => {
    // Medido ao vivo: "Individual quota reached... Resets in 18h43m26s". O
    // failover não tinha para onde ir, e a cota de um motor derrubou os quatro
    // papéis por dezoito horas com outro motor conectado e ocioso ao lado.
    expect(runtimes(resolveRuntimeChain('ra', SO_ANTIGRAVITY, DEFAULTS))).toEqual(['antigravity'])
  })

  it('com os conectados, a cadeia passa a ter para onde ir', () => {
    const chain = resolveRuntimeChain('ra', SO_ANTIGRAVITY, DEFAULTS, ['antigravity', 'codex'])
    expect(runtimes(chain)).toEqual(['antigravity', 'codex'])
  })

  it('a escolha do cliente continua em PRIMEIRO lugar — a reserva não muda preferência', () => {
    const chain = resolveRuntimeChain('ra', { agents: { ra: { runtime: 'codex' } } }, DEFAULTS, [
      'antigravity',
      'codex',
    ])
    expect(runtimes(chain)[0]).toBe('codex')
  })

  it('os fallbacks que o cliente declarou vêm antes da reserva', () => {
    const config = {
      agents: { ra: { runtime: 'codex', fallbacks: [{ runtime: 'claude' }] } },
    }
    const chain = resolveRuntimeChain('ra', config, DEFAULTS, ['antigravity'])
    expect(runtimes(chain)).toEqual(['codex', 'claude', 'antigravity'])
  })

  it('motor conectado que já está na cadeia não entra duas vezes', () => {
    const chain = resolveRuntimeChain('ra', SO_ANTIGRAVITY, DEFAULTS, ['antigravity'])
    expect(runtimes(chain)).toEqual(['antigravity'])
  })

  it('lista de conectados vazia não muda nada — nenhuma regressão', () => {
    expect(runtimes(resolveRuntimeChain('ra', SO_ANTIGRAVITY, DEFAULTS, []))).toEqual([
      'antigravity',
    ])
  })

  it('motor conectado desconhecido é descartado, como qualquer outro', () => {
    const chain = resolveRuntimeChain('ra', SO_ANTIGRAVITY, DEFAULTS, ['motor-inventado'])
    expect(runtimes(chain)).toEqual(['antigravity'])
  })
})
