-- Duas colunas que guardam, na ficha do item, o que a ligação das peças
-- descobre — fora do `estado`, que é o retrato de agora e é trocado por
-- inteiro a cada webhook e a cada varredura:
--   vinculo_origem  como o vínculo com o pedido foi achado
--   conferencia     resultado da conferência da tarefa
-- Aditiva e idempotente: linhas antigas ficam com NULL.
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado —
--   scripts/db-migrate.sh
--   psql "$DATABASE_URL" -f prisma/repo-item-ligacao-migration.sql

ALTER TABLE repo_items ADD COLUMN IF NOT EXISTS vinculo_origem TEXT;
ALTER TABLE repo_items ADD COLUMN IF NOT EXISTS conferencia JSONB;
