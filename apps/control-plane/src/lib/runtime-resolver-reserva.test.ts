import { describe, it, expect } from 'vitest'
import { resolveRuntimeChain, type ResolverDefaults } from './runtime-resolver.js'

const DEFAULTS: ResolverDefaults = {
  runtimeByRole: { ra: 'antigravity', po: 'antigravity', sm: 'antigravity', qa: 'antigravity' },
}
const SO_ANTIGRAVITY = { agents: { ra: { runtime: 'antigravity' } } }
const runtimes = (c: Array<{ runtime: string }>) => c.map((s) => s.runtime)

describe('a cadeia ganha reserva dos motores conectados', () => {
  it('projeto com UM motor escolhido não fica mais sem reserva — a cadeia canônica fecha o buraco', () => {
    // Medido ao vivo em 26/08: "Individual quota reached... Resets in
    // 18h43m26s". O failover não tinha para onde ir, e a cota de um motor
    // derrubou os quatro papéis por dezoito horas com outro motor conectado e
    // ocioso ao lado. Isto ainda listava só `['antigravity']` até 01/09/2026:
    // sem `motoresConectados`, a cadeia dependia inteiramente da reserva
    // abaixo. Agora (PR desta task) a CADEIA CANÔNICA da instância
    // (codex → antigravity → claude) completa o resto sozinha, mesmo sem
    // nenhum motor conectado passado aqui — o incidente de 26/08 não se repete
    // nem precisando de `motoresConectados`.
    expect(runtimes(resolveRuntimeChain('ra', SO_ANTIGRAVITY, DEFAULTS))).toEqual([
      'antigravity',
      'codex',
      'claude',
    ])
  })

  it('a reserva de conectados é redundante agora, e por isso inofensiva — mesmo resultado com ou sem ela', () => {
    // A cadeia canônica cobre os TRÊS motores que existem (F6_AGENT_RUNTIMES),
    // então `motoresConectados` nunca acrescenta nada hoje — ela só continua
    // existindo como reserva para um motor futuro fora da cadeia canônica.
    const semReserva = resolveRuntimeChain('ra', SO_ANTIGRAVITY, DEFAULTS)
    const comReserva = resolveRuntimeChain('ra', SO_ANTIGRAVITY, DEFAULTS, ['antigravity', 'codex'])
    expect(runtimes(comReserva)).toEqual(runtimes(semReserva))
    expect(runtimes(comReserva)).toEqual(['antigravity', 'codex', 'claude'])
  })

  it('a escolha do cliente continua em PRIMEIRO lugar — a reserva não muda preferência', () => {
    const chain = resolveRuntimeChain('ra', { agents: { ra: { runtime: 'codex' } } }, DEFAULTS, [
      'antigravity',
      'codex',
    ])
    expect(runtimes(chain)[0]).toBe('codex')
  })

  it('os fallbacks que o cliente declarou vêm antes da cadeia canônica e da reserva', () => {
    const config = {
      agents: { ra: { runtime: 'codex', fallbacks: [{ runtime: 'claude' }] } },
    }
    const chain = resolveRuntimeChain('ra', config, DEFAULTS, ['antigravity'])
    expect(runtimes(chain)).toEqual(['codex', 'claude', 'antigravity'])
  })

  it('motor conectado que já está na cadeia não entra duas vezes', () => {
    const chain = resolveRuntimeChain('ra', SO_ANTIGRAVITY, DEFAULTS, ['antigravity'])
    expect(runtimes(chain)).toEqual(['antigravity', 'codex', 'claude'])
  })

  it('lista de conectados vazia não muda nada — nenhuma regressão', () => {
    expect(runtimes(resolveRuntimeChain('ra', SO_ANTIGRAVITY, DEFAULTS, []))).toEqual([
      'antigravity',
      'codex',
      'claude',
    ])
  })

  it('motor conectado desconhecido é descartado, como qualquer outro', () => {
    const chain = resolveRuntimeChain('ra', SO_ANTIGRAVITY, DEFAULTS, ['motor-inventado'])
    expect(runtimes(chain)).toEqual(['antigravity', 'codex', 'claude'])
  })
})
