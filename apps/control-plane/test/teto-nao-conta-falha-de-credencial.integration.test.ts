import { describe, expect, it } from 'vitest'
import { PrismaClient } from '@prisma/client'

/**
 * Prova, contra um banco REAL, a decisão do dono de 20/08/2026: uma missão que
 * morreu pedindo login não ocupa vaga do teto diário. Foi cobrar essas vagas
 * que transformou uma credencial vencida em três dias de esteira parada — 13
 * das 24 missões do dia queimadas por falhas que nunca chegaram a usar o motor.
 *
 * Integração de verdade (não mock do Prisma) porque o que está sendo testado é
 * exatamente a SEMÂNTICA DE SQL do filtro sobre campo JSON, que mock nenhum
 * reproduz. A armadilha medida no banco de produção antes de escolher o
 * desenho: `NOT (result->>'falhaDeCredencial' = 'true')` avalia NULL para toda
 * missão com `result` nulo — 13 das 24 daquele dia — e NULL não é TRUE, então
 * um NOT ingênuo excluiria quase tudo e o teto nunca seria atingido. Por isso
 * o código usa duas contagens e uma subtração.
 *
 * Banco vem de GITORCH_TEST_DATABASE_URL, nunca de DATABASE_URL (mesma
 * disciplina de db-migrate.integration.test.ts; repo público, nada hardcoded).
 */
const testUrl = process.env['GITORCH_TEST_DATABASE_URL']

describe.skipIf(!testUrl)('teto diário não conta missão morta por credencial', () => {
  it('desconta do total apenas as missões marcadas, e missões com result nulo continuam contando', async () => {
    const prisma = new PrismaClient({ datasources: { db: { url: testUrl } } })
    const projeto = await prisma.project.findFirst()
    if (!projeto) throw new Error('banco de teste sem projeto; rode o seed antes')

    const inicioDoDia = new Date()
    inicioDoDia.setHours(0, 0, 0, 0)
    const criadas: string[] = []

    try {
      // Falha comum: `result` nulo, como a esmagadora maioria das missões.
      const comum = await prisma.mission.create({
        data: { projectId: projeto.id, type: 'qa', status: 'failed', payload: {} },
      })
      // Falha de credencial: marcada de propósito no momento de gravar a falha.
      const porCredencial = await prisma.mission.create({
        data: {
          projectId: projeto.id,
          type: 'qa',
          status: 'failed',
          payload: {},
          result: { falhaDeCredencial: true },
        },
      })
      criadas.push(comum.id, porCredencial.id)

      const total = await prisma.mission.count({ where: { createdAt: { gte: inicioDoDia } } })
      const mortasPorCredencial = await prisma.mission.count({
        where: {
          createdAt: { gte: inicioDoDia },
          result: { path: ['falhaDeCredencial'], equals: true },
        },
      })

      // A marcada é encontrada...
      expect(mortasPorCredencial).toBeGreaterThanOrEqual(1)
      // ...e a de result nulo NÃO é: se a semântica de JSON nulo mordesse, a
      // subtração comeria missões legítimas e o teto nunca fecharia.
      expect(total - mortasPorCredencial).toBeGreaterThanOrEqual(1)

      const soAComum = await prisma.mission.count({
        where: { id: comum.id, result: { path: ['falhaDeCredencial'], equals: true } },
      })
      expect(soAComum).toBe(0)
    } finally {
      if (criadas.length) await prisma.mission.deleteMany({ where: { id: { in: criadas } } })
      await prisma.$disconnect()
    }
  })
})
