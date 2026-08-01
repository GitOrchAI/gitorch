import { describe, expect, it } from 'vitest'
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MIGRATION_LEDGER } from '../src/lib/migration-ledger.js'

/**
 * Achado de review F2.1.6#4: toda propriedade de risco de scripts/db-migrate.sh
 * (idempotência, retomada após morte no meio, bootstrap virgem, o achado #1 do
 * seed) tinha sido provada uma única vez, à mão, contra um Postgres efêmero.
 * Aqui isso vira automático, rodando o script REAL (não uma reimplementação em
 * TS) contra um Postgres descartável.
 *
 * A conexão-admin (usada só pra criar/derrubar os bancos descartáveis de cada
 * teste) vem inteiramente de GITORCH_TEST_DATABASE_URL no ambiente — nunca
 * hardcoded (repo público). Nome DIFERENTE de DATABASE_URL de propósito:
 * src/test/setup.ts sobrescreve DATABASE_URL globalmente com um placeholder
 * falso antes de qualquer teste rodar (mock padrão da suíte), então reusar o
 * mesmo nome aqui faria a suíte crer que sempre há um banco alcançável quando
 * na verdade a URL não conecta a lugar nenhum.
 *
 * Se a variável não estiver setada, ou apontar pra algo inalcançável, a
 * suíte inteira pula (não falha) — não há Postgres containerizado disponível
 * neste ambiente de execução; a alternativa adotada foi o Postgres local já
 * presente na VM de dev, com um banco descartável de nome único criado e
 * derrubado por teste.
 */
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
  } catch {
    // Best-effort: se sobrar uma conexão presa (ex.: teste anterior falhou no
    // meio), não deixamos isso derrubar a suíte inteira — o banco descartável
    // fica órfão, não é segredo nem custa nada relevante.
  }
}

function runScript(
  dbUrl: string,
  extraEnv: Record<string, string> = {}
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [scriptPath], {
    cwd: controlPlaneDir,
    env: { ...process.env, DATABASE_URL: dbUrl, ...extraEnv },
    encoding: 'utf-8',
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function countLedgerRows(dbUrl: string): number {
  return Number(psql(dbUrl, 'SELECT count(*) FROM gitorch_schema_migrations'))
}

function appliedNames(dbUrl: string): string[] {
  const out = psql(dbUrl, 'SELECT name FROM gitorch_schema_migrations ORDER BY name')
  return out === '' ? [] : out.split('\n')
}

function planIds(dbUrl: string): string[] {
  const out = psql(dbUrl, 'SELECT id FROM plans ORDER BY id')
  return out === '' ? [] : out.split('\n')
}

// Aplica só o baseline (CREATE completo derivado do schema.prisma atual) —
// sem seed, sem ledger. É exatamente o estado em que um processo morto entre
// o baseline e o seed deixaria o banco: `users` (e todo o resto do schema)
// existe, `plans` está vazia, gitorch_schema_migrations nem existe ainda.
function applyBaselineOnly(dbUrl: string): void {
  const script = execFileSync(
    join(controlPlaneDir, 'node_modules', '.bin', 'prisma'),
    [
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema-datamodel',
      'prisma/schema.prisma',
      '--script',
    ],
    { cwd: controlPlaneDir, encoding: 'utf-8' }
  )
  // Arquivo real, não `-f /dev/stdin`: psql tenta fazer seek no descritor
  // pra reportar progresso, e isso falha com "No such device or address"
  // quando o stdin é um pipe anônimo (como o que execFileSync cria pra
  // `input`) em vez de um terminal ou arquivo de verdade.
  const dir = mkdtempSync(join(tmpdir(), 'gitorch-baseline-'))
  const file = join(dir, 'baseline.sql')
  try {
    writeFileSync(file, script)
    execFileSync('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-f', file])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function createLedgerTable(dbUrl: string): void {
  psql(
    dbUrl,
    'CREATE TABLE IF NOT EXISTS gitorch_schema_migrations (' +
      'name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())'
  )
}

function registerAsApplied(dbUrl: string, migrationName: string): void {
  const shaOutput = execFileSync('sha256sum', [join(controlPlaneDir, 'prisma', migrationName)], {
    encoding: 'utf-8',
  })
  const checksum = shaOutput.split(' ')[0]
  if (!checksum) throw new Error(`sha256sum sem saída utilizável para ${migrationName}`)
  psql(
    dbUrl,
    `INSERT INTO gitorch_schema_migrations(name, checksum) VALUES ('${migrationName}', '${checksum}')`
  )
}

// Segura um lock ACCESS EXCLUSIVE numa tabela via uma sessão psql interativa
// mantida aberta (stdin nunca fechado) até releaseLock() mandar ROLLBACK. É a
// injeção de falha real do teste (b): o script tenta ALTER TABLE nessa mesma
// tabela, choca com o lock, estoura lock_timeout e morre com exit != 0 — sem
// nunca tocar em nenhum arquivo do repo.
function holdLock(dbUrl: string, table: string): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', [dbUrl, '-v', 'ON_ERROR_STOP=1', '-qtA'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let buffered = ''
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('utf-8')
      if (buffered.includes('locked')) {
        child.stdout.off('data', onData)
        resolve(child)
      }
    }
    child.stdout.on('data', onData)
    child.on('error', reject)
    child.stdin.write(`BEGIN;\nLOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE;\nSELECT 'locked';\n`)
  })
}

function releaseLock(child: ChildProcessWithoutNullStreams): void {
  child.stdin.write('ROLLBACK;\n\\q\n')
  child.kill()
}

function uniqueDbName(label: string): string {
  return `gitorch_it_${label}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

describe.skipIf(!reachable)('scripts/db-migrate.sh (integração, postgres real descartável)', () => {
  it('bootstrap virgem: 1a rodada aplica baseline+seed+ledger, 2a é no-op limpo', () => {
    const dbName = uniqueDbName('virgin')
    createDb(dbName)
    const dbUrl = withDatabase(requireAdminUrl(), dbName)
    try {
      const first = runScript(dbUrl)
      expect(first.status).toBe(0)
      expect(countLedgerRows(dbUrl)).toBe(MIGRATION_LEDGER.length)
      expect(planIds(dbUrl)).toEqual(['free', 'pro', 'solo', 'team'])

      const second = runScript(dbUrl)
      expect(second.status).toBe(0)
      expect(second.stdout).toContain('0 aplicadas agora')
      expect(countLedgerRows(dbUrl)).toBe(MIGRATION_LEDGER.length)
    } finally {
      dropDb(dbName)
    }
  }, 30000)

  it('achado F2.1.6#1: morte entre baseline e seed não deixa o banco sem planos pra sempre', () => {
    const dbName = uniqueDbName('f1seed')
    createDb(dbName)
    const dbUrl = withDatabase(requireAdminUrl(), dbName)
    try {
      applyBaselineOnly(dbUrl)
      expect(planIds(dbUrl)).toEqual([])

      const resumed = runScript(dbUrl)
      expect(resumed.status).toBe(0)
      expect(planIds(dbUrl)).toEqual(['free', 'pro', 'solo', 'team'])
      expect(countLedgerRows(dbUrl)).toBe(MIGRATION_LEDGER.length)
    } finally {
      dropDb(dbName)
    }
  }, 30000)

  it('falha real no meio do ledger (lock timeout) não perde progresso; retomada aplica só o resto', async () => {
    const dbName = uniqueDbName('mid')
    createDb(dbName)
    const dbUrl = withDatabase(requireAdminUrl(), dbName)
    let lockHolder: ChildProcessWithoutNullStreams | undefined
    try {
      applyBaselineOnly(dbUrl)
      createLedgerTable(dbUrl)
      const cut = 6
      for (const name of MIGRATION_LEDGER.slice(0, cut)) registerAsApplied(dbUrl, name)
      expect(countLedgerRows(dbUrl)).toBe(cut)

      lockHolder = await holdLock(dbUrl, 'users')
      const failing = runScript(dbUrl, { PGOPTIONS: '-c lock_timeout=1000' })
      expect(failing.status).not.toBe(0)
      expect(countLedgerRows(dbUrl)).toBe(cut)

      releaseLock(lockHolder)
      lockHolder = undefined

      const resumed = runScript(dbUrl)
      expect(resumed.status).toBe(0)
      expect(countLedgerRows(dbUrl)).toBe(MIGRATION_LEDGER.length)
      expect(appliedNames(dbUrl)).toEqual([...MIGRATION_LEDGER].sort())
    } finally {
      if (lockHolder) releaseLock(lockHolder)
      dropDb(dbName)
    }
  }, 30000)

  it("achado F2.1.6#3: falha ao ler o ledger aborta em vez de mascarar como 'nada aplicado'", async () => {
    const dbName = uniqueDbName('read')
    createDb(dbName)
    const dbUrl = withDatabase(requireAdminUrl(), dbName)
    let lockHolder: ChildProcessWithoutNullStreams | undefined
    try {
      const first = runScript(dbUrl)
      expect(first.status).toBe(0)
      expect(countLedgerRows(dbUrl)).toBe(MIGRATION_LEDGER.length)

      // Lock na própria tabela do ledger (não numa tabela de schema): a
      // falha injetada é bem no SELECT que lê o que já foi aplicado — o
      // exato passo do achado #3. Com o bug antigo (mapfile < <(...)), essa
      // leitura falhava em silêncio e o script seguia como se nada tivesse
      // sido aplicado, chegando a imprimir "aplicando billing-migration.sql"
      // antes de eventualmente morrer em outro lugar. Com a correção, ele
      // aborta ali mesmo — nenhuma linha "aplicando" chega a ser impressa.
      lockHolder = await holdLock(dbUrl, 'gitorch_schema_migrations')
      const failing = runScript(dbUrl, { PGOPTIONS: '-c lock_timeout=1000' })
      expect(failing.status).not.toBe(0)
      expect(failing.stdout).not.toContain('aplicando')
    } finally {
      if (lockHolder) releaseLock(lockHolder)
      dropDb(dbName)
    }
  }, 30000)
})
