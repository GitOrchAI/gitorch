-- Trava do parecer, que se solta sozinha por data (mesmo padrão de
-- engine_connections.renewal_locked_until) — impede duas execuções
-- concorrentes do QA publicarem parecer para o MESMO head do MESMO pull
-- request ao mesmo tempo.
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado —
--   scripts/db-migrate.sh
--   psql "$DATABASE_URL" -f prisma/parecer-trava-migration.sql

ALTER TABLE repo_items ADD COLUMN IF NOT EXISTS parecer_travado_ate TIMESTAMP(3);
ALTER TABLE repo_items ADD COLUMN IF NOT EXISTS parecer_trava_head_sha TEXT;
