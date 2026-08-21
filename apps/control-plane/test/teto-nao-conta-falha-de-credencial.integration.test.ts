import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/**
 * Prova, contra um Postgres REAL, a regra de contagem que sustenta a decisão do
 * dono de 20/08/2026: uma missão que morreu pedindo login não ocupa vaga do teto
 * diário. Cobrar essas vagas foi o que transformou uma credencial vencida em três
 * dias de esteira parada — 13 das 24 missões daquele dia queimadas por falhas que
 * nunca chegaram a usar o motor.
 *
 * O QUE ESTÁ SOB TESTE é a semântica de SQL sobre campo JSON com NULL, que é onde
 * mora a armadilha e o que decidiu o desenho do código em scheduler.ts. Medido no
 * banco de produção antes de escrever: `NOT (result->>'falhaDeCredencial' = 'true')`
 * avalia NULL para toda missão com `result` nulo — 13 das 24 daquele dia — e NULL
 * não é TRUE, então um NOT ingênuo excluiria quase tudo e o teto NUNCA fecharia.
 * Trocaria um teto que fecha cedo demais por um que não fecha nunca, em silêncio.
 * Por isso o código faz DUAS contagens (total, e marcadas com `equals: true`) e
 * subtrai.
 *
 * Duas escolhas deliberadas, cada uma por um motivo já pago com CI vermelho:
 *
 * 1. psql direto, não PrismaClient: `src/test/setup.ts` substitui '@prisma/client'
 *    por um MockPrismaClient em TODA a suíte (vitest.config.ts aplica o setup
 *    também à pasta test/). Um teste de integração que importasse o Prisma aqui
 *    não falaria com banco nenhum — e poderia passar VERDE sem testar nada, que é
 *    o pior tipo de falha. Mesmo caminho de db-migrate.integration.test.ts.
 *
 * 2. Tabela própria e descartável, não a tabela `missions` do app: o banco de
 *    GITORCH_TEST_DATABASE_URL no CI sobe VAZIO de propósito, porque quem cria o
 *    schema ali é justamente o teste do ledger de migração. Depender do schema do
 *    app tornaria este teste refém da ordem de execução. A tabela abaixo replica
 *    só o que importa para a regra: uma coluna `jsonb` que aceita NULL.
 */
const url = process.env['GITORCH_TEST_DATABASE_URL']

const sql = (q: string): string =>
  execFileSync('psql', [url as string, '-tAc', q], { stdio: 'pipe' })
    .toString()
    .trim()

describe.skipIf(!url)('teto diário não conta missão morta por credencial', () => {
  it('a subtração desconta só o que foi marcado, e linha com result NULL continua contando', () => {
    const tabela = `teto_teste_${randomUUID().replace(/-/g, '')}`
    sql(`CREATE TABLE ${tabela} (id text PRIMARY KEY, status text NOT NULL, result jsonb)`)
    try {
      // Falha comum: `result` NULL, como a esmagadora maioria das missões reais.
      sql(`INSERT INTO ${tabela} (id, status, result) VALUES ('comum', 'failed', NULL)`)
      // Falha de credencial: marcada de propósito no momento de gravar a falha.
      sql(
        `INSERT INTO ${tabela} (id, status, result)
         VALUES ('cred', 'failed', '{"falhaDeCredencial": true}')`
      )
      // Missão que deu certo: nunca deve ser descontada.
      sql(`INSERT INTO ${tabela} (id, status, result) VALUES ('ok', 'completed', NULL)`)

      const total = Number(sql(`SELECT count(*) FROM ${tabela}`))
      const marcadas = Number(
        sql(`SELECT count(*) FROM ${tabela} WHERE (result->>'falhaDeCredencial')::boolean IS TRUE`)
      )

      expect(total).toBe(3)
      // Só a marcada é descontada — nem a falha comum, nem a que deu certo.
      expect(marcadas).toBe(1)
      // E as duas de result NULL SOBREVIVEM à subtração. Se a semântica de JSON
      // nulo mordesse aqui, o teto nunca mais fecharia.
      expect(total - marcadas).toBe(2)

      // O filtro ingênuo que NÃO foi usado no código, para que ninguém o
      // "simplifique" de volta sem ver este teste quebrar: sem o `IS TRUE`, a
      // comparação com NULL devolve NULL, e as DUAS linhas legítimas somem.
      const ingenuo = Number(
        sql(`SELECT count(*) FROM ${tabela} WHERE NOT (result->>'falhaDeCredencial' = 'true')`)
      )
      expect(ingenuo).toBe(0)
    } finally {
      sql(`DROP TABLE IF EXISTS ${tabela}`)
    }
  })
})
