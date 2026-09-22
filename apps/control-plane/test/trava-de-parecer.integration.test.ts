import { describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adquirirTravaDeParecer } from '../src/services/trava-de-parecer.js'

// We must unmock @prisma/client because vitest is configured with a global setup file
// (src/test/setup.ts) that mocks it by default.
vi.unmock('@prisma/client')

const controlPlaneDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = join(controlPlaneDir, 'scripts', 'db-migrate.sh')
const adminUrl = process.env['GITORCH_TEST_DATABASE_URL']

function canConnect(url: string): boolean {
  try {
    execFileSync('psql', [url, '-tAc', 'SELECT 1'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const reachable = Boolean(adminUrl) && canConnect(adminUrl as string)

const isCI = Boolean(process.env['CI'])
if (isCI && !reachable) {
  throw new Error('GITORCH_TEST_DATABASE_URL unreachable')
}

function requireAdminUrl(): string {
  if (!adminUrl) throw new Error('GITORCH_TEST_DATABASE_URL ausente')
  return adminUrl
}

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${dbName}`
  return parsed.toString()
}

function psql(url: string, sql: string): string {
  return execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', sql], {
    encoding: 'utf-8',
  }).trim()
}

function createDb(name: string): void {
  psql(requireAdminUrl(), `CREATE DATABASE "${name}"`)
}

function dropDb(name: string): void {
  try {
    psql(requireAdminUrl(), `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  } catch {}
}

function uniqueDbName(label: string): string {
  return `gitorch_it_${label}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

function applySchema(dbUrl: string): void {
  const result = spawnSync('bash', [scriptPath], {
    cwd: controlPlaneDir,
    env: { ...process.env, DATABASE_URL: dbUrl },
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    throw new Error(`scripts/db-migrate.sh falhou:\n${result.stdout}\n${result.stderr}`)
  }
}

describe.skipIf(!reachable)(
  'trava-de-parecer (integration)',
  () => {
    it('exatamente UMA chamada concorrente para o mesmo head devolve true sob concorrência real', async () => {
      const dbName = uniqueDbName('trava_conc')
      createDb(dbName)
      const dbUrl = withDatabase(requireAdminUrl(), dbName)

      let prisma1: any
      let prisma2: any

      try {
        applySchema(dbUrl)

        const projectId = randomUUID()
        psql(
          dbUrl,
          `INSERT INTO projects (id, wing_id, name, updated_at) ` +
            `VALUES ('${projectId}', 'owner/repo', 'repo', now())`
        )

        // Precisamos importar o PrismaClient de verdade agora que desmockamos
        const { PrismaClient: RealPrismaClient } = await import('@prisma/client')

        prisma1 = new RealPrismaClient({ datasources: { db: { url: dbUrl } } })
        prisma2 = new RealPrismaClient({ datasources: { db: { url: dbUrl } } })

        const numeroDoPr = 42
        const headSha = 'abcdef123'
        const agora = new Date()

        // Pré-inserir o RepoItem para não focar no conflito de Upsert, mas sim
        // no UPDATE condicional (updateMany), que é a real trava de concorrência.
        psql(dbUrl, `
          INSERT INTO repo_items (id, project_id, tipo, numero, estado, criado_em, atualizado_em)
          VALUES ('item1', '${projectId}', 'pr', ${numeroDoPr}, '{"status":"unknown"}', now(), now())
        `)

        const promises = [
          adquirirTravaDeParecer({
            prisma: prisma1,
            projectId,
            numeroDoPr,
            headSha,
            agora
          }),
          adquirirTravaDeParecer({
            prisma: prisma2,
            projectId,
            numeroDoPr,
            headSha,
            agora
          })
        ]

        const resultados = await Promise.all(promises)

        const lockAdquirido = resultados.filter(v => v === true).length
        const lockRejeitado = resultados.filter(v => v === false).length

        expect(lockAdquirido).toBe(1)
        expect(lockRejeitado).toBe(1)

      } finally {
        if (prisma1) await prisma1.$disconnect()
        if (prisma2) await prisma2.$disconnect()
        dropDb(dbName)
      }
    }, 30000)
  }
)
