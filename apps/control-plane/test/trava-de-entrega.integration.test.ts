import { describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { criarTravaDeEntrega } from '../src/services/trava-de-entrega.js'
import type { PrismaClient } from '@prisma/client'

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

describe.skipIf(!reachable)('trava de entrega (integration, banco real)', () => {
  it('liga, sobrevive a "reiniciar" (cliente novo), desliga e a migração é aplicada pelo ledger', async () => {
    const dbName = uniqueDbName('trava_entrega')
    createDb(dbName)
    const dbUrl = withDatabase(requireAdminUrl(), dbName)

    let primeiro: PrismaClient | undefined
    let depoisDoRestart: PrismaClient | undefined

    try {
      applySchema(dbUrl)
      const { PrismaClient: RealPrismaClient } = await import('@prisma/client')
      primeiro = new RealPrismaClient({ datasources: { db: { url: dbUrl } } })

      const antes = criarTravaDeEntrega(primeiro)
      expect((await antes.estadoDaTrava()).ligada).toBe(false)
      expect(await antes.podeIniciarTrabalho()).toBe(true)

      const ligada = await antes.ligarTrava({ motivo: 'troca de versão', por: 'entregador' })
      expect(ligada.ligada).toBe(true)
      expect(await antes.podeIniciarTrabalho()).toBe(false)
      // idempotente: a segunda chamada não muda o "desde" gravado
      const denovo = await antes.ligarTrava({ motivo: 'outra', por: 'outro' })
      expect(denovo.desde?.getTime()).toBe(ligada.desde?.getTime())
      expect(psql(dbUrl, 'SELECT count(*) FROM trava_de_entrega')).toBe('1')
      await primeiro.$disconnect()
      primeiro = undefined

      // "Reinício do serviço": cliente de banco e serviço novos, mesmo banco.
      depoisDoRestart = new RealPrismaClient({ datasources: { db: { url: dbUrl } } })
      const novo = criarTravaDeEntrega(depoisDoRestart)
      const lida = await novo.estadoDaTrava()
      expect(lida.ligada).toBe(true)
      expect(lida.motivo).toBe('troca de versão')
      expect(lida.ligadaPor).toBe('entregador')
      expect(lida.desde?.getTime()).toBe(ligada.desde?.getTime())
      expect(await novo.podeIniciarTrabalho()).toBe(false)

      await novo.desligarTrava({ por: 'entregador' })
      expect((await novo.estadoDaTrava()).ligada).toBe(false)
      expect(await novo.podeIniciarTrabalho()).toBe(true)
    } finally {
      if (primeiro) await primeiro.$disconnect()
      if (depoisDoRestart) await depoisDoRestart.$disconnect()
      dropDb(dbName)
    }
  }, 60000)
})
