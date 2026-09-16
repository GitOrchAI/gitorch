-- A ficha do item do repositório (pedido, tarefa, alerta): estado atual, para
-- decisão rápida. O histórico continua em `events` — nunca duplicado aqui (ver
-- docs/superpowers/plans/2026-09-15-gitorch-repositorio-inteiro.md, Fase 0-1).
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado —
--   scripts/db-migrate.sh
--   psql "$DATABASE_URL" -f prisma/repo-item-migration.sql

CREATE TABLE IF NOT EXISTS repo_items (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tipo           TEXT NOT NULL,
  numero         INTEGER NOT NULL,
  estado         JSONB NOT NULL,
  origem         TEXT,
  issue_number   INTEGER,
  entendimento   JSONB,
  criado_em      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS repo_items_project_tipo_numero_key
  ON repo_items (project_id, tipo, numero);

-- A varredura de 30 min (Tarefa 1.3) e o motor do próximo passo (Tarefa 3.5)
-- leem "todas as fichas de um tipo neste projeto" — índice quente.
CREATE INDEX IF NOT EXISTS repo_items_project_tipo_idx
  ON repo_items (project_id, tipo);
