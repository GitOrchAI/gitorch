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

// Achado FW-6-fixture / FW-5: nome único e reconhecível da fixture do teste
// "achado I4" abaixo — escrita DENTRO de prisma/, o mesmo diretório que
// src/lib/migration-ledger.test.ts varre inteiro e exige 1:1 com o ledger.
const I4_FIXTURE_NAME = '2026-08-x-migration.sql'
const i4FixturePath = join(controlPlaneDir, 'prisma', I4_FIXTURE_NAME)

// Achado FW-5: autocura, roda incondicionalmente ao CARREGAR este arquivo —
// antes de qualquer describe/it, inclusive quando `reachable` é false e a
// suíte inteira abaixo é pulada (describe.skipIf). Se uma rodada anterior
// morreu (SIGKILL) no meio do teste "achado I4" logo abaixo, o `finally`
// dele nunca chega a rodar e a fixture fica presa em prisma/ pra sempre —
// quebrando tanto este arquivo (achado I4 veria a fixture já existir) quanto
// src/lib/migration-ledger.test.ts (exige 1:1 exato entre prisma/*-migration
// .sql e o ledger) em TODA rodada seguinte, até alguém notar e apagar à mão.
// Isto garante que a PRÓXIMA vez que este arquivo é importado — reachable ou
// não — o estado começa limpo.
rmSync(i4FixturePath, { force: true })

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

// Simula um banco NÃO-virgem e DESATUALIZADO (achado C1): schema atual
// (applyBaselineOnly já criou tudo, billing-migration.sql incluída) menos as
// colunas que SÓ billing-migration.sql cria. É o estado real de um legado
// A1/dev que nunca rodou essa migração — o `applyBaselineOnly` puro (usado
// pelo teste do achado F2.1.6#1, abaixo) não serve pra isto porque o
// baseline É o schema.prisma atual, que JÁ tem essas colunas de fábrica.
function stripBillingColumns(dbUrl: string): void {
  psql(
    dbUrl,
    'ALTER TABLE "plans" DROP COLUMN IF EXISTS "tier_rank", ' +
      'DROP COLUMN IF EXISTS "max_concurrent_missions", ' +
      'DROP COLUMN IF EXISTS "seats", ' +
      'DROP COLUMN IF EXISTS "features"; ' +
      'ALTER TABLE "users" DROP COLUMN IF EXISTS "stripe_customer_id"'
  )
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

  it('achado C1: banco NÃO-virgem e DESATUALIZADO (schema anterior a billing-migration.sql) não deadlocka — o ledger roda ANTES do seed', () => {
    const dbName = uniqueDbName('outofdate')
    createDb(dbName)
    const dbUrl = withDatabase(requireAdminUrl(), dbName)
    try {
      applyBaselineOnly(dbUrl)
      // Estado real de um legado A1/dev que nunca rodou billing-migration.sql
      // (a 1ª entrada do ledger): `plans` sem tierRank/maxConcurrentMissions/
      // seats/features, `users` sem stripeCustomerId. `users` já existe →
      // o script toma o caminho NÃO-virgem.
      stripBillingColumns(dbUrl)

      const result = runScript(dbUrl)
      // Achado C1: se o seed rodasse ANTES do ledger (ordem antiga), este
      // `expect` falharia — o seed tentaria escrever `tier_rank` numa
      // `plans` que ainda não tem a coluna, morreria com exit != 0, e o
      // ledger (que traria a coluna de volta via billing-migration.sql)
      // NUNCA chegaria a rodar. Com a ordem corrigida, billing-migration.sql
      // roda primeiro (repõe as colunas) e o seed, rodando depois, funciona.
      expect(result.status).toBe(0)
      expect(planIds(dbUrl)).toEqual(['free', 'pro', 'solo', 'team'])
      expect(appliedNames(dbUrl)).toContain('billing-migration.sql')
      expect(countLedgerRows(dbUrl)).toBe(MIGRATION_LEDGER.length)
    } finally {
      dropDb(dbName)
    }
  }, 30000)

  // Achado FW-5: este teste escreve uma fixture *-migration.sql DENTRO de
  // prisma/ — o MESMO diretório que src/lib/migration-ledger.test.ts varre
  // inteiro (readdirSync) exigindo 1:1 exato com o ledger. Os dois arquivos
  // de teste estão no mesmo `include` do vitest e, por padrão, arquivos
  // rodam em paralelo (workers/threads separados) — se migration-ledger.
  // test.ts ler prisma/ na janela em que esta fixture existe, vê um arquivo
  // a mais e quebra por uma corrida, não por um bug real. A correção não é
  // aqui dentro (não dá pra "esconder" a fixture de um readdirSync que
  // precisa vê-la pra provar o guard do shell): scripts/db-migrate.sh
  // extrai/compara com o MESMO glob `prisma/*-migration.sql`, então a
  // fixture TEM que estar ali de verdade. A correção é em
  // apps/control-plane/package.json ("test"): este arquivo roda numa 2ª
  // invocação de `vitest run` SEPARADA, só depois da 1ª (que cobre
  // src/**/*.test.ts, incluindo migration-ledger.test.ts) já ter terminado
  // — as duas nunca mais se sobrepõem no tempo. A limpeza da fixture (linha
  // ~40 deste arquivo, incondicional ao carregar o módulo) cobre o caso
  // complementar: uma rodada anterior morta (SIGKILL) que nunca chegou a
  // rodar o `finally` abaixo.
  it('achado I4: um arquivo *-migration.sql em disco sem entrada correspondente extraída do ledger TS aborta o deploy (guard de contagem, não mais "-ge 12" hardcoded)', () => {
    const dbName = uniqueDbName('ledgerdrift')
    createDb(dbName)
    const dbUrl = withDatabase(requireAdminUrl(), dbName)
    // Fixture com dígito no nome: exatamente o caso que a regex de extração
    // do script (`[a-z-]+-migration\.sql`) NUNCA vai casar — simula um SQL
    // real em prisma/ que "sumiria" do ledger extraído pelo shell, mas que
    // migration-ledger.ts (TS) e o disco concordam ter. O guard (comparação
    // exata de listas desde o achado FW-6) tem que pegar essa divergência,
    // não importa de qual lado ela vem.
    rmSync(i4FixturePath, { force: true })
    try {
      writeFileSync(
        i4FixturePath,
        '-- fixture de teste (achado I4), removido ao fim do teste\nSELECT 1;\n'
      )
      const result = runScript(dbUrl)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('dessincronizada')
    } finally {
      rmSync(i4FixturePath, { force: true })
      dropDb(dbName)
    }
  }, 30000)
})
