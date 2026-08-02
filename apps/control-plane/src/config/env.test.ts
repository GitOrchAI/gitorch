import { describe, it, expect } from 'vitest'
import { envSchema } from './env.js'

// Campos sem default no schema — precisam estar presentes pra parse() não
// falhar por outro motivo que não o que este teste quer provar.
const REQUIRED = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/gitorch',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'x'.repeat(32),
}

function parseTrustProxy(raw: string | undefined): boolean {
  const env = raw === undefined ? { ...REQUIRED } : { ...REQUIRED, GITORCH_TRUST_PROXY: raw }
  const result = envSchema.parse(env)
  return result.GITORCH_TRUST_PROXY
}

// Achado I2: z.coerce.boolean() é Boolean(string) — "0"/"false"/"no" viram
// `true` (só "" vira false). Um operador desligando com
// GITORCH_TRUST_PROXY=0 conseguia o OPOSTO do que pediu, e aterrissava no
// achado I1 sem proxy nenhum na frente. A correção só liga com o valor
// afirmativo explícito '1' — mesma convenção que pipelineCheckEnabled
// (config/pipeline-check.ts) e resolveMissionCpus (config/mission-cpus.ts)
// já usam nesta branch.
describe('GITORCH_TRUST_PROXY (achado I2)', () => {
  it('só liga com o valor explícito "1"', () => {
    expect(parseTrustProxy('1')).toBe(true)
  })

  it.each([
    ['0', '0'],
    ['false', 'false'],
    ['no', 'no'],
    ['', 'vazio'],
    ['   ', 'só espaço'],
    ['true', 'true (não é "1")'],
    ['TRUE', 'maiúsculo'],
  ])('NÃO liga com %s (%s) — z.coerce.boolean() cru achava que sim', (raw) => {
    expect(parseTrustProxy(raw)).toBe(false)
  })

  it('ausente = desligado (default seguro)', () => {
    expect(parseTrustProxy(undefined)).toBe(false)
  })
})
