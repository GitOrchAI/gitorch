import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Prova, contra Postgres real, as duas garantias que
 * prisma/dev-session-migration.sql alega sobre o índice único PARCIAL
 * `dev_sessions_open_per_issue` (achado de review da esteira, F3.6+):
 *
 *  1. duas linhas VIVAS (closed_at IS NULL) para a mesma
 *     (project_id, issue_number) são rejeitadas — é o que impede duas
 *     delegações da MESMA issue (que geram `session_name` diferentes e por
 *     isso caem as duas no ramo `create` do upsert em `abrirSessao`) de
 *     abrirem duas linhas vivas ao mesmo tempo.
 *  2. depois de fechar a primeira (preencher closed_at), inserir uma
 *     segunda linha viva para a MESMA issue PASSA — é isso que permite
 *     re-delegação da issue preservando o histórico de tentativas.
 *
 * Mesmo padrão de apps/control-plane/test/db-migrate.integration.test.ts:
 * roda scripts/db-migrate.sh de verdade (não uma reimplementação em TS)
 * contra um Postgres descartável, e usa GITORCH_TEST_DATABASE_URL como
 * conexão-admin — nunca hardcoded (repo público). Se a variável não estiver
 * setada (ou apontar pra algo inalcançável), a suíte se auto-pula fora de
 * CI; em CI, falha alto-e-claro em vez de se auto-pular em silêncio (mesmo
 * guard do arquivo-irmão).
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

const isCI = Boolean(process.env['CI'])
if (isCI && !reachable) {
  throw new Error(
    adminUrl
      ? 'GITORCH_TEST_DATABASE_URL setada mas o Postgres está inalcançável em CI — a suíte de ' +
          'integração do índice parcial dev_sessions_open_per_issue não pode se auto-pular aqui; ' +
          'verifique o serviço "postgres" do job zero-tolerance em .github/workflows/ci.yml.'
      : 'GITORCH_TEST_DATABASE_URL ausente em CI — a suíte de integração do índice parcial ' +
          'dev_sessions_open_per_issue não pode se auto-pular aqui; verifique se a var está ' +
          'declarada no job zero-tolerance (.github/workflows/ci.yml) E na chave "env" da task ' +
          '"test" em turbo.json (o turbo em modo strict apaga env não declarada ali antes do ' +
          'processo filho nascer).'
  )
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
  } catch {
    // Best-effort: banco descartável órfão não é segredo nem custa nada
    // relevante — não deixamos isso derrubar a suíte.
  }
}

function uniqueDbName(label: string): string {
  return `gitorch_it_${label}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

// Aplica o schema completo (baseline + ledger, incluindo
// dev-session-migration.sql — a fonte real dos índices sob teste) do jeito
// que produção aplica: rodando o script real, não uma reimplementação.
function applySchema(dbUrl: string): void {
  const result = spawnSync('bash', [scriptPath], {
    cwd: controlPlaneDir,
    env: { ...process.env, DATABASE_URL: dbUrl },
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    throw new Error(
      `scripts/db-migrate.sh falhou ao preparar o banco de teste:\n${result.stdout}\n${result.stderr}`
    )
  }
}

function criarProjeto(dbUrl: string): string {
  const projectId = randomUUID()
  // `updated_at` não tem default no banco: é `@updatedAt` no schema.prisma,
  // gerido pelo Prisma Client em runtime, não pelo Postgres — precisa vir
  // explícito num INSERT raw como este.
  psql(
    dbUrl,
    `INSERT INTO projects (id, wing_id, name, updated_at) ` +
      `VALUES ('${projectId}', 'owner/repo', 'repo', now())`
  )
  return projectId
}

function inserirSessaoViva(
  dbUrl: string,
  projectId: string,
  issueNumber: number,
  sessionName: string
): void {
  // `updated_at` explícito pelo mesmo motivo de criarProjeto: o baseline de
  // banco virgem cria `dev_sessions` a partir do schema.prisma (a tabela já
  // existe quando dev-session-migration.sql roda depois — seu `CREATE TABLE
  // IF NOT EXISTS` com DEFAULT CURRENT_TIMESTAMP não pega), então a coluna
  // fica sem default nesse caminho.
  psql(
    dbUrl,
    `INSERT INTO dev_sessions (id, project_id, issue_number, session_name, updated_at) ` +
      `VALUES ('${randomUUID()}', '${projectId}', ${issueNumber}, '${sessionName}', now())`
  )
}

describe.skipIf(!reachable)(
  'índice único parcial dev_sessions_open_per_issue (integração, postgres real descartável)',
  () => {
    it('duas linhas VIVAS para a mesma (project_id, issue_number) são rejeitadas pelo índice parcial', () => {
      const dbName = uniqueDbName('partial_reject')
      createDb(dbName)
      const dbUrl = withDatabase(requireAdminUrl(), dbName)
      try {
        applySchema(dbUrl)
        const projectId = criarProjeto(dbUrl)

        // Duas delegações da MESMA issue geram session_name DIFERENTES (é
        // exatamente o caso real que abrirSessao's upsert não protege
        // sozinho, porque o upsert usa `where: { sessionName }`).
        inserirSessaoViva(dbUrl, projectId, 42, 'sessions/primeira')

        expect(() => inserirSessaoViva(dbUrl, projectId, 42, 'sessions/segunda')).toThrowError(
          /duplicate key value violates unique constraint "dev_sessions_open_per_issue"/
        )

        const linhas = psql(
          dbUrl,
          `SELECT count(*) FROM dev_sessions WHERE project_id = '${projectId}' AND issue_number = 42`
        )
        expect(linhas).toBe('1')
      } finally {
        dropDb(dbName)
      }
    }, 30000)

    it('depois de fechar a primeira (closed_at preenchido), inserir uma segunda linha viva para a mesma issue PASSA', () => {
      const dbName = uniqueDbName('partial_reopen')
      createDb(dbName)
      const dbUrl = withDatabase(requireAdminUrl(), dbName)
      try {
        applySchema(dbUrl)
        const projectId = criarProjeto(dbUrl)

        inserirSessaoViva(dbUrl, projectId, 24, 'sessions/tentativa-1')
        psql(
          dbUrl,
          `UPDATE dev_sessions SET closed_at = now(), closed_reason = 'abandoned' ` +
            `WHERE project_id = '${projectId}' AND issue_number = 24`
        )

        // Re-delegação: a issue volta a ter sessão viva, preservando a linha
        // fechada anterior como histórico de tentativas — não substituindo-a.
        expect(() => inserirSessaoViva(dbUrl, projectId, 24, 'sessions/tentativa-2')).not.toThrow()

        const total = psql(
          dbUrl,
          `SELECT count(*) FROM dev_sessions WHERE project_id = '${projectId}' AND issue_number = 24`
        )
        expect(total).toBe('2')

        const vivas = psql(
          dbUrl,
          `SELECT count(*) FROM dev_sessions WHERE project_id = '${projectId}' AND issue_number = 24 ` +
            `AND closed_at IS NULL`
        )
        expect(vivas).toBe('1')
      } finally {
        dropDb(dbName)
      }
    }, 30000)
  }
)
