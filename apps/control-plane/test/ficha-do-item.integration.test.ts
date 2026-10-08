import { describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  atualizarFichaDoItem,
  lerFichaDoItem,
  mesclarConferenciaDoItem,
} from '../src/services/ficha-do-item.js'

// O setup global do vitest (src/test/setup.ts) mocka o @prisma/client; aqui o
// banco é de verdade.
vi.unmock('@prisma/client')

const controlPlaneDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = join(controlPlaneDir, 'scripts', 'db-migrate.sh')
const sqlDaLigacao = join(controlPlaneDir, 'prisma', 'repo-item-ligacao-migration.sql')
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

if (Boolean(process.env['CI']) && !reachable) {
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
    env: { ...process.env, PGOPTIONS: '-c client_min_messages=warning' },
  }).trim()
}

function psqlArquivo(url: string, arquivo: string): void {
  execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-qtA', '-f', arquivo], {
    encoding: 'utf-8',
    env: { ...process.env, PGOPTIONS: '-c client_min_messages=warning' },
  })
}

function dropDb(name: string): void {
  try {
    psql(requireAdminUrl(), `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  } catch {}
}

function criarBancoMigrado(label: string): { nome: string; url: string } {
  const nome = `gitorch_it_${label}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  psql(requireAdminUrl(), `CREATE DATABASE "${nome}"`)
  const url = withDatabase(requireAdminUrl(), nome)
  const result = spawnSync('bash', [scriptPath], {
    cwd: controlPlaneDir,
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    throw new Error(`scripts/db-migrate.sh falhou:\n${result.stdout}\n${result.stderr}`)
  }
  return { nome, url }
}

describe.skipIf(!reachable)('ficha do item (integração com o banco)', () => {
  it('a migração da ligação é idempotente e deixa NULL nas linhas antigas', () => {
    const { nome, url } = criarBancoMigrado('ligacao_sql')
    try {
      const projectId = randomUUID()
      psql(
        url,
        `INSERT INTO projects (id, wing_id, name, updated_at) VALUES ('${projectId}', 'o/r', 'r', now())`
      )
      // Volta ao formato anterior à migração: sem as duas colunas, com uma
      // linha "antiga" já gravada.
      psql(url, `ALTER TABLE repo_items DROP COLUMN vinculo_origem, DROP COLUMN conferencia`)
      psql(
        url,
        `INSERT INTO repo_items (id, project_id, tipo, numero, estado, origem, issue_number, atualizado_em)
         VALUES ('antigo', '${projectId}', 'pr', 1, '{"status":"open"}', 'jules_gitorch', 10, now())`
      )

      psqlArquivo(url, sqlDaLigacao)
      psqlArquivo(url, sqlDaLigacao)

      const colunas = psql(
        url,
        `SELECT column_name || ':' || data_type FROM information_schema.columns
         WHERE table_name = 'repo_items' AND column_name IN ('vinculo_origem', 'conferencia')
         ORDER BY column_name`
      )
      expect(colunas.split('\n')).toEqual(['conferencia:jsonb', 'vinculo_origem:text'])
      expect(
        psql(url, `SELECT vinculo_origem IS NULL AND conferencia IS NULL FROM repo_items`)
      ).toBe('t')
      expect(psql(url, `SELECT origem || ':' || issue_number FROM repo_items`)).toBe(
        'jules_gitorch:10'
      )
    } finally {
      dropDb(nome)
    }
  }, 60000)

  it('com o Prisma de verdade, a ficha só ganha vínculo e as colunas novas persistem', async () => {
    const { nome, url } = criarBancoMigrado('ligacao_ficha')
    const { PrismaClient } = await import('@prisma/client')
    const prisma = new PrismaClient({ datasources: { db: { url } } })
    try {
      const projectId = randomUUID()
      psql(
        url,
        `INSERT INTO projects (id, wing_id, name, updated_at) VALUES ('${projectId}', 'o/r', 'r', now())`
      )
      const base = { prisma: prisma as never, projectId, tipo: 'pr' as const, numero: 7 }

      await atualizarFichaDoItem({
        ...base,
        estado: { status: 'open', conflito: true },
        origem: 'jules_gitorch',
        issueNumber: 5,
        vinculoOrigem: 'formal',
        conferencia: { veredito: 'ok' },
      })
      // webhook sem issue de origem + varredura que troca só o retrato
      await atualizarFichaDoItem({
        ...base,
        estado: { status: 'open' },
        origem: null,
        issueNumber: null,
      })
      await atualizarFichaDoItem({ ...base, estado: { status: 'merged' } })

      const ficha = await lerFichaDoItem({ ...base })
      expect(ficha?.estado).toEqual({ status: 'merged' })
      expect(ficha?.origem).toBe('jules_gitorch')
      expect(ficha?.issueNumber).toBe(5)
      expect(ficha?.vinculoOrigem).toBe('formal')
      expect(ficha?.conferencia).toEqual({ veredito: 'ok' })

      // sem estado numa ficha nova: nasce com o estado mínimo
      const nova = await atualizarFichaDoItem({ ...base, numero: 8, origem: 'pessoa' })
      expect(nova.estado).toEqual({ status: 'desconhecido' })
    } finally {
      await prisma.$disconnect()
      dropDb(nome)
    }
  }, 60000)

  it('substituto solto no texto de fora é limpo antes de ir ao jsonb (estado, entendimento e conferência)', async () => {
    const { nome, url } = criarBancoMigrado('ligacao_ficha_surrogate')
    const { PrismaClient } = await import('@prisma/client')
    const prisma = new PrismaClient({ datasources: { db: { url } } })
    try {
      const projectId = randomUUID()
      psql(
        url,
        `INSERT INTO projects (id, wing_id, name, updated_at) VALUES ('${projectId}', 'o/r', 'r', now())`
      )
      const base = { prisma: prisma as never, projectId, tipo: 'issue' as const, numero: 9 }
      const solto = 'titulo\uD83D cortado'

      await atualizarFichaDoItem({
        ...base,
        estado: { status: 'open', verificacao: solto },
        entendimento: {
          deOndeVeio: 'ok',
          oQueMuda: 'ok',
          queAjusteE: 'ok',
          porQueExiste: solto,
        },
        conferencia: { original: { titulo: solto } },
      })
      const ok = await mesclarConferenciaDoItem({
        prisma: prisma as never,
        projectId,
        tipo: 'issue',
        numero: 9,
        parcial: { ajuste: { motivo: `fim${solto}\uDE00` } },
      })
      expect(ok).toBe(true)

      const ficha = await lerFichaDoItem({ ...base })
      expect(ficha?.estado).toEqual({ status: 'open', verificacao: 'titulo\uFFFD cortado' })
      expect((ficha?.entendimento as { porQueExiste: string }).porQueExiste).toBe(
        'titulo\uFFFD cortado'
      )
      expect(ficha?.conferencia).toEqual({
        original: { titulo: 'titulo\uFFFD cortado' },
        ajuste: { motivo: 'fimtitulo\uFFFD cortado\uFFFD' },
      })
    } finally {
      await prisma.$disconnect()
      dropDb(nome)
    }
  }, 60000)
})
