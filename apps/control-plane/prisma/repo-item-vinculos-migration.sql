-- Grafo completo de vínculos do item (issue #877): hierarquia, milestone,
-- campos do Project v2, labels/assignees, PRs ligados, sessões do Jules
-- casadas e — só para PR — CI e último parecer do QA. Tabela 1:1 com
-- repo_items; ADITIVA, nunca mexe no schema existente.
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado —
--   scripts/db-migrate.sh
--   psql "$DATABASE_URL" -f prisma/repo-item-vinculos-migration.sql

CREATE TABLE IF NOT EXISTS repo_item_vinculos (
  id                    TEXT PRIMARY KEY,
  repo_item_id          TEXT NOT NULL UNIQUE REFERENCES repo_items(id) ON DELETE CASCADE,
  hierarquia            JSONB,
  milestone             JSONB,
  project_fields        JSONB,
  labels_and_assignees  JSONB,
  prs_ligados           JSONB,
  sessoes_jules         JSONB,
  qa_review             JSONB,
  status_check_rollup   JSONB,
  criado_em             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
