/**
 * Ledger de migração (E14/OV#1): a ordem CANÔNICA e congelada dos SQLs
 * aditivos de prisma/. Antes disto eram arquivos soltos aplicados na mão —
 * sem ordem, sem registro, sem caminho pra banco virgem. O runner
 * (scripts/db-migrate.sh) grava cada aplicação na tabela
 * gitorch_schema_migrations e o teste de drift garante que nenhum SQL novo
 * entra sem ganhar posição aqui.
 *
 * Ordem = cronologia real de criação (data do commit que introduziu cada
 * arquivo; verificado via `git log --follow` em cada um dos 12 antes de
 * escrever este array — não é alfabética nem por adivinhação). As três
 * migrações nascidas no MESMO commit (client-environment-activity,
 * project-owner-scope, telegram-link — resgate #334) são independentes entre
 * si (nenhuma referencia tabela/coluna criada pela outra); a ordem relativa
 * entre elas não importa para correção, só precisa ser fixa. Todos os 12 são
 * aditivos/idempotentes (ver auditoria no commit desta task), mas a ordem
 * fixa torna o replay determinístico mesmo assim.
 */
export const MIGRATION_LEDGER = [
  'billing-migration.sql',
  'setup-wizard-migration.sql',
  'diagnosis-job-migration.sql',
  'client-environment-activity-migration.sql',
  'project-owner-scope-migration.sql',
  'telegram-link-migration.sql',
  'github-app-install-migration.sql',
  'graph-cache-migration.sql',
  'resources-lock-migration.sql',
  'resources-status-migration.sql',
  'claude-quota-migration.sql',
  'agent-question-migration.sql',
  'client-token-migration.sql',
  'dev-session-migration.sql',
  'jules-plan-migration.sql',
  'repo-access-recheck-migration.sql',
  'publicacao-migration.sql',
  'github-token-refresh-migration.sql',
  'conserto-de-publicacao-migration.sql',
  'aviso-de-retrabalho-migration.sql',
  'desejo-pendente-migration.sql',
  'byok-conta-do-dev-migration.sql',
  'aviso-de-publicacao-migration.sql',
  'trava-de-renovacao-migration.sql',
  'waiting-status-migration.sql',
  'esteira-terminal-migration.sql',
  'autonomia-do-projeto-migration.sql',
] as const

/**
 * Só o que falta aplicar, na ordem do ledger. `applied` é a lista de nomes já
 * gravados em gitorch_schema_migrations.
 *
 * Entradas em branco/whitespace são ruído (nunca um nome de migração real) e
 * são ignoradas — nem contam como aplicadas, nem disparam o erro de "banco à
 * frente do código". Tratar branco como "desconhecida" abortaria o deploy à
 * toa; tratar como aplicada esconderia uma migração pendente. Nenhum dos dois
 * é o default seguro — ignorar é.
 */
export function computePending(applied: string[]): string[] {
  const known = new Set<string>(MIGRATION_LEDGER)
  const meaningful = applied.filter((name) => name.trim() !== '')
  for (const name of meaningful) {
    if (!known.has(name)) {
      throw new Error(
        `migração desconhecida no banco: '${name}' — o banco está à frente deste código; abortar o deploy`
      )
    }
  }
  const done = new Set(meaningful)
  return MIGRATION_LEDGER.filter((m) => !done.has(m))
}
