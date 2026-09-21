import { describe, it, expect, beforeEach } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'
import { adquirirTravaDeParecer } from '../src/services/trava-de-parecer.js'
import { execFileSync } from 'node:child_process'

// TDD - Task 3.4
function canConnect(url: string): boolean {
  try {
    execFileSync('psql', [url, '-tAc', 'SELECT 1'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

// Teste de integração de concorrência que bate num banco real usando a
// env GITORCH_TEST_DATABASE_URL, mesmo padrão de setup de outros testes de
// integração no control-plane.
const url = process.env['GITORCH_TEST_DATABASE_URL'] || ''

describe.skipIf(!url || !canConnect(url))('trava-de-parecer (integration)', () => {
  const prisma = new PrismaClient({
    datasources: {
      db: { url: url },
    },
  })

  let testProjectId: string
  let testUserId: string

  beforeEach(async () => {
    // Para rodar local (e no CI), GITORCH_TEST_DATABASE_URL precisa estar setado
    if (!process.env['GITORCH_TEST_DATABASE_URL']) {
      console.warn('Skipping integration test: GITORCH_TEST_DATABASE_URL not set')
      return
    }

    testUserId = `test-user-${randomUUID()}`
    testProjectId = `test-proj-${randomUUID()}`

    // Como os testes do control-plane mockam o PrismaClient nativo (`@prisma/client`) em setup.ts,
    // a gente desvia dessa restrição instanciando uma importação real ou usando sql cru.
    // Pra evitar psql ou require tricks complexos, rodamos uma query sql básica (ou skipamos insert
    // e testamos só a trava num projeto fake assumindo que PrismaDaTravaDeParecer confia no schema da
    // tabela e RepoItem não checa foreign key do DB no nível do test fake, MAS é integração real.)
    // Vamos usar importação dinâmica e sem mock para a persistência real:
    const { execFileSync } = await import('node:child_process')
    const url = process.env['GITORCH_TEST_DATABASE_URL'] || ''
    const executeSql = (sql: string) =>
      execFileSync('psql', [url, '-c', sql], { encoding: 'utf-8' })

    const devAccountId = randomUUID()
    executeSql(`
      INSERT INTO users (id) VALUES ('${testUserId}');
      INSERT INTO dev_accounts (id, user_id, provider, provider_account_id) VALUES ('${devAccountId}', '${testUserId}', 'github', '${randomUUID()}');
      INSERT INTO projects (id, user_id, dev_account_id, wing_id, full_name, installation_id) VALUES ('${testProjectId}', '${testUserId}', '${devAccountId}', '${randomUUID()}', 'test/repo', 123);
    `)
  })

  it('exatamente UMA chamada concorrente para o mesmo head devolve true', async () => {
    if (!process.env['GITORCH_TEST_DATABASE_URL']) return

    const agora = new Date()
    const headSha = 'abc123sha'

    // Dispara 5 chamadas em paralelo (Promise.all) para tentar travar o mesmo PR/head
    const resultados = await Promise.all([
      adquirirTravaDeParecer({
        prisma: prisma as never,
        projectId: testProjectId,
        numeroDoPr: 100,
        headSha,
        agora,
      }),
      adquirirTravaDeParecer({
        prisma: prisma as never,
        projectId: testProjectId,
        numeroDoPr: 100,
        headSha,
        agora,
      }),
      adquirirTravaDeParecer({
        prisma: prisma as never,
        projectId: testProjectId,
        numeroDoPr: 100,
        headSha,
        agora,
      }),
      adquirirTravaDeParecer({
        prisma: prisma as never,
        projectId: testProjectId,
        numeroDoPr: 100,
        headSha,
        agora,
      }),
      adquirirTravaDeParecer({
        prisma: prisma as never,
        projectId: testProjectId,
        numeroDoPr: 100,
        headSha,
        agora,
      }),
    ])

    const locksAdquiridos = resultados.filter((r) => r === true).length
    const locksRejeitados = resultados.filter((r) => r === false).length

    // Apenas UMA conseguiu a trava, as outras falharam
    expect(locksAdquiridos).toBe(1)
    expect(locksRejeitados).toBe(4)
  })

  it('permite travar novo head mesmo com trava vigente do anterior', async () => {
    if (!process.env['GITORCH_TEST_DATABASE_URL']) return

    const agora = new Date()

    // A primeira tentativa no head1 funciona
    const travou1 = await adquirirTravaDeParecer({
      prisma: prisma as never,
      projectId: testProjectId,
      numeroDoPr: 200,
      headSha: 'head1',
      agora,
    })
    expect(travou1).toBe(true)

    // Outro processo tentando travar o MESMO head falha
    const travou1Dnv = await adquirirTravaDeParecer({
      prisma: prisma as never,
      projectId: testProjectId,
      numeroDoPr: 200,
      headSha: 'head1',
      agora,
    })
    expect(travou1Dnv).toBe(false)

    // Um novo commit chegou, head mudou para head2.
    // Mesmo a trava anterior ainda não vencida, este novo head DEVE passar.
    const travou2 = await adquirirTravaDeParecer({
      prisma: prisma as never,
      projectId: testProjectId,
      numeroDoPr: 200,
      headSha: 'head2',
      agora,
    })
    expect(travou2).toBe(true)
  })
})
