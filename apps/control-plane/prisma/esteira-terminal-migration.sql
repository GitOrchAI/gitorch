-- Ciclo de vida TERMINAL da sessão do dev assíncrono + rastreio de incidentes
-- de infra. ADITIVA e não-destrutiva (só ADD COLUMN / CREATE TABLE, tudo
-- idempotente). Entra no MIGRATION_LEDGER como a última entrada.
--
-- POR QUÊ (medido ao vivo 29/08/2026): a esteira dos dois projetos parou
-- porque as sessões que o Jules já deu como COMPLETED/FAILED (21 de 23) nunca
-- são fechadas do lado do GitOrch — ficam com closed_at nulo e o contador de
-- concorrência as conta contra o teto de 15 da conta, folga negativa, zero
-- delegação. Estas colunas são o que o novo passo terminal (sessao-terminal.ts)
-- e a análise de 2 falhas (D51) precisam para decidir SEM abandonar de vez.
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado —
--   scripts/db-migrate.sh                                   # caminho normal (ledger)
--   psql "$DATABASE_URL" -f prisma/esteira-terminal-migration.sql   # este SQL direto

-- dev_sessions: quantas vezes esta issue já foi redelegada por entrega que não
-- mesclou (carregado adiante em abrirSessao a partir da sessão anterior da
-- mesma issue) e quando a análise de "por que o Jules falhou" rodou pela
-- última vez para ela. Nulo = nunca rodou.
ALTER TABLE "dev_sessions" ADD COLUMN IF NOT EXISTS "requeue_count" SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE "dev_sessions" ADD COLUMN IF NOT EXISTS "analysis_done_at" TIMESTAMP(3);

-- infra_incidents: um problema de CI/CD do repositório do cliente, rastreado
-- pela IDENTIDADE ESTÁVEL do workflow (wf:<workflow_id>) — nunca pelo nome de
-- exibição, que o Dependabot muda a cada rodada ("- Update #N"). Um incidente =
-- uma linha = no máximo uma issue e um PR em curso. Fecha (cleared_at) quando a
-- última rodada do workflow fica verde ou o PR mescla.
CREATE TABLE IF NOT EXISTS "infra_incidents" (
  "id"                 TEXT NOT NULL,
  "project_id"         TEXT NOT NULL,
  -- ci-do-cliente | config-de-actions | dependabot-travado | alerta-de-seguranca
  -- | scaffolding-do-gitorch | workflow-morto
  "classe"             TEXT NOT NULL,
  -- wf:<workflow_id> | dep:config | sec:<ghsa-id>
  "identidade_estavel" TEXT NOT NULL,
  "issue_number"       INTEGER,
  "pr_number"          INTEGER,
  -- Quantos PRs já fracassaram em resolver este incidente. Ao 3º, escala.
  "pr_attempts"        SMALLINT NOT NULL DEFAULT 0,
  "first_seen_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Preenchido quando o sintoma para (última rodada verde ou PR mesclado).
  "cleared_at"         TIMESTAMP(3),
  -- Preenchido quando o incidente resistiu a 3 PRs e foi levado ao dono.
  "escalated_at"       TIMESTAMP(3),
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "infra_incidents_pkey" PRIMARY KEY ("id")
);

-- Um incidente por (projeto, identidade) — o upsert do RA depende disto para
-- não abrir dois rastreios do mesmo workflow falhando.
CREATE UNIQUE INDEX IF NOT EXISTS "infra_incidents_project_identidade_key"
  ON "infra_incidents" ("project_id", "identidade_estavel");

-- Filtro quente: "incidentes abertos deste projeto".
CREATE INDEX IF NOT EXISTS "infra_incidents_project_id_cleared_at_idx"
  ON "infra_incidents" ("project_id", "cleared_at");

-- Projeto some -> os incidentes dele somem junto (mesmo padrão de
-- Event/ApiKey/AgentQuestion).
ALTER TABLE "infra_incidents"
  DROP CONSTRAINT IF EXISTS "infra_incidents_project_id_fkey";
ALTER TABLE "infra_incidents"
  ADD CONSTRAINT "infra_incidents_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
