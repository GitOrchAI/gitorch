import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MIGRATION_LEDGER, computePending } from './migration-ledger.js'

const prismaDir = join(dirname(fileURLToPath(import.meta.url)), '../../prisma')

describe('MIGRATION_LEDGER', () => {
  it('lista TODO *-migration.sql existente em prisma/ (drift guard: SQL novo sem entrada no ledger quebra aqui)', () => {
    const onDisk = readdirSync(prismaDir)
      .filter((f) => f.endsWith('-migration.sql'))
      .sort()
    expect([...MIGRATION_LEDGER].sort()).toEqual(onDisk)
  })
  it('ordem cronológica congelada (mudar a ordem é mudança de contrato)', () => {
    expect(MIGRATION_LEDGER[0]).toBe('billing-migration.sql')
    expect(MIGRATION_LEDGER[MIGRATION_LEDGER.length - 1]).toBe('agent-question-migration.sql')
  })
})

describe('computePending', () => {
  it('devolve só o que falta, na ordem do ledger', () => {
    const applied = MIGRATION_LEDGER.slice(0, 3) as string[]
    expect(computePending(applied)).toEqual(MIGRATION_LEDGER.slice(3))
  })
  it('nome aplicado desconhecido = erro (banco à frente do código; deploy deve abortar)', () => {
    expect(() => computePending(['zz-desconhecida.sql'])).toThrow(/desconhecida/)
  })
  it('tudo aplicado = vazio', () => {
    expect(computePending([...MIGRATION_LEDGER])).toEqual([])
  })
  it('vazio = tudo pendente (banco recém-criado, ledger ainda sem linhas)', () => {
    expect(computePending([])).toEqual([...MIGRATION_LEDGER])
  })
  // Lição de review real (F2.1.5): input em branco/whitespace nunca deve ser
  // tratado como um nome de migração de verdade — nem como "desconhecida" (o
  // que abortaria o deploy à toa), nem como aplicada. É ruído a ignorar.
  it('entrada em branco/whitespace no array de aplicadas é ignorada, não vira erro', () => {
    expect(() => computePending([''])).not.toThrow()
    expect(() => computePending(['   '])).not.toThrow()
    expect(computePending(['', '   '])).toEqual([...MIGRATION_LEDGER])
  })
})
