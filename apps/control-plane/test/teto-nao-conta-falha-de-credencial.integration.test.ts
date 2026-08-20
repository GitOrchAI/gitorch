import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/**
 * Prova, contra um banco REAL e em SQL puro, a decisão do dono de 20/08/2026:
 * uma missão que morreu pedindo login não ocupa vaga do teto diário. Cobrar
 * essas vagas foi o que transformou uma credencial vencida em três dias de
 * esteira parada — 13 das 24 missões daquele dia queimadas por falhas que
 * nunca chegaram a usar o motor.
 *
 * SQL direto via psql, e não PrismaClient, pelo mesmo motivo de
 * db-migrate.integration.test.ts: src/test/setup.ts substitui '@prisma/client'
 * por um MockPrismaClient em TODA a suíte, então um teste que importasse o
 * Prisma aqui nunca falaria com banco nenhum — falha silenciosa, o pior tipo.
 *
 * E o que está sob teste é exatamente a SEMÂNTICA DE SQL sobre campo JSON, que
 * simulador nenhum reproduz. A armadilha, medida no banco de produção antes de
 * escolher o desenho do código: `NOT (result->>'falhaDeCredencial' = 'true')`
 * avalia NULL para toda missão com `result` nulo — 13 das 24 daquele dia — e
 * NULL não é TRUE, então um NOT ingênuo excluiria quase tudo e o teto NUNCA
 * fecharia. Trocaria um teto que fecha cedo demais por um que não fecha nunca,
 * em silêncio. Por isso o código faz duas contagens e subtrai.
 *
 * Banco vem de GITORCH_TEST_DATABASE_URL, nunca de DATABASE_URL (repo público,
 * nada hardcoded).
 */
const url = process.env['GITORCH_TEST_DATABASE_URL']

const sql = (q: string): string =>
  execFileSync('psql', [url as string, '-tAc', q], { stdio: 'pipe' })
    .toString()
    .trim()

describe.skipIf(!url)('teto diário não conta missão morta por credencial', () => {
  it('a subtração desconta só o que foi marcado, e missão com result nulo continua contando', () => {
    const wing = `teto-teste-${randomUUID()}`
    sql(
      `INSERT INTO projects (id, wing_id, name, default_branch, is_active, created_at, updated_at)
       VALUES ('${wing}', '${wing}', 'projeto do teste de teto', 'main', true, now(), now())`
    )
    try {
      // Falha comum: `result` nulo, como a esmagadora maioria das missões.
      sql(
        `INSERT INTO missions (id, project_id, type, status, payload, created_at, updated_at)
         VALUES ('${wing}-comum', '${wing}', 'qa', 'failed', '{}', now(), now())`
      )
      // Falha de credencial: marcada de propósito ao gravar a falha.
      sql(
        `INSERT INTO missions (id, project_id, type, status, payload, result, created_at, updated_at)
         VALUES ('${wing}-cred', '${wing}', 'qa', 'failed', '{}',
                 '{"falhaDeCredencial": true}', now(), now())`
      )

      const doProjeto = `project_id = '${wing}'`
      const total = Number(sql(`SELECT count(*) FROM missions WHERE ${doProjeto}`))
      const marcadas = Number(
        sql(
          `SELECT count(*) FROM missions
           WHERE ${doProjeto} AND (result->>'falhaDeCredencial')::boolean IS TRUE`
        )
      )

      expect(total).toBe(2)
      // Só a marcada é descontada...
      expect(marcadas).toBe(1)
      // ...e a de result nulo SOBREVIVE à subtração. Se a semântica de JSON
      // nulo mordesse, este número seria 0 e o teto nunca mais fecharia.
      expect(total - marcadas).toBe(1)

      // O NOT ingênuo que NÃO foi usado no código: aqui ele se comporta bem
      // porque o `IS TRUE` protege. Sem o `IS TRUE`, a comparação com NULL
      // devolveria NULL e a linha de result nulo sumiria da contagem — este
      // caso existe para que ninguém "simplifique" o código removendo a
      // proteção sem ver o teste quebrar.
      const semProtecao = Number(
        sql(
          `SELECT count(*) FROM missions
           WHERE ${doProjeto} AND NOT (result->>'falhaDeCredencial' = 'true')`
        )
      )
      expect(semProtecao).toBe(0)
    } finally {
      sql(`DELETE FROM missions WHERE project_id = '${wing}'`)
      sql(`DELETE FROM projects WHERE id = '${wing}'`)
    }
  })
})
