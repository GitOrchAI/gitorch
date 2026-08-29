import { describe, expect, it } from 'vitest'
import { MIGRATION_LEDGER } from '../lib/migration-ledger.js'
import { conferirBancoNoArranque, estadoDoBanco, recadoDeBancoAtrasado } from './banco-atrasado.js'

describe('banco atrasado', () => {
  it('banco em dia: nada pendente', () => {
    expect(estadoDoBanco([...MIGRATION_LEDGER])).toEqual({ pendentes: [], emDia: true })
  })

  it('o incidente de 26/08: a última migração do ledger não aplicada aparece pendente', () => {
    const ultima = MIGRATION_LEDGER[MIGRATION_LEDGER.length - 1] as string
    const semAUltima = MIGRATION_LEDGER.filter((m) => m !== ultima)
    const estado = estadoDoBanco([...semAUltima])
    expect(estado.emDia).toBe(false)
    expect(estado.pendentes).toEqual([ultima])
  })

  it('banco virgem: tudo pendente, na ordem canônica', () => {
    const estado = estadoDoBanco([])
    expect(estado.emDia).toBe(false)
    expect(estado.pendentes).toEqual([...MIGRATION_LEDGER])
  })

  it('o recado diz o comando que resolve, não só que quebrou', () => {
    const recado = recadoDeBancoAtrasado(['waiting-status-migration.sql'])
    expect(recado).toContain('db-migrate.sh')
    expect(recado).toContain('uma mudança de banco')
  })

  it('o recado conta certo no plural', () => {
    expect(recadoDeBancoAtrasado(['a.sql', 'b.sql'])).toContain('2 mudanças de banco')
  })

  it('o recado nunca carrega nome de banco, usuário ou endereço', () => {
    // Vai para um chat: o que basta é o que fazer.
    const recado = recadoDeBancoAtrasado(['a.sql'])
    expect(recado).not.toMatch(/postgres:\/\/|DATABASE_URL|senha|password/i)
  })
})

describe('conferirBancoNoArranque', () => {
  it('o incidente de 26/08: banco atrasado grita no log E no chat do dono', async () => {
    const ultima = MIGRATION_LEDGER[MIGRATION_LEDGER.length - 1] as string
    const avisos: string[] = []
    const warns: string[] = []
    const estado = await conferirBancoNoArranque({
      prisma: {
        $queryRawUnsafe: async () =>
          MIGRATION_LEDGER.filter((m) => m !== ultima).map((name) => ({ name })),
      },
      avisar: async (texto) => {
        avisos.push(texto)
        return true
      },
      log: { warn: (m) => warns.push(m), info: () => undefined },
    })
    expect(estado?.emDia).toBe(false)
    // Os DOIS canais: o log sozinho foi exatamente o que não bastou.
    expect(warns.join()).toContain(ultima)
    expect(warns.join()).toContain('db-migrate.sh')
    expect(avisos).toHaveLength(1)
    expect(avisos[0]).toContain('db-migrate.sh')
  })

  it('banco em dia: nenhum aviso ao dono', async () => {
    const avisos: string[] = []
    const estado = await conferirBancoNoArranque({
      prisma: { $queryRawUnsafe: async () => MIGRATION_LEDGER.map((name) => ({ name })) },
      avisar: async (t) => {
        avisos.push(t)
        return true
      },
      log: { warn: () => undefined, info: () => undefined },
    })
    expect(estado?.emDia).toBe(true)
    expect(avisos).toHaveLength(0)
  })

  it('a conferência falhando NÃO derruba o arranque', async () => {
    // Banco virgem sem a tabela do ledger, ou banco fora do ar no instante do
    // boot: o processo segue subindo. O objetivo é não repetir o silêncio, não
    // criar um jeito novo de o produto não subir.
    const warns: string[] = []
    const estado = await conferirBancoNoArranque({
      prisma: {
        $queryRawUnsafe: async () => {
          throw new Error('relation "gitorch_schema_migrations" does not exist')
        },
      },
      avisar: async () => true,
      log: { warn: (m) => warns.push(m), info: () => undefined },
    })
    expect(estado).toBeNull()
    expect(warns.join()).toContain('não consegui conferir')
  })

  it('sem chat ligado: avisa só no log, sem explodir', async () => {
    const warns: string[] = []
    await conferirBancoNoArranque({
      prisma: { $queryRawUnsafe: async () => [] },
      avisar: null,
      log: { warn: (m) => warns.push(m), info: () => undefined },
    })
    expect(warns.join()).toContain('BANCO ATRASADO')
  })
})
