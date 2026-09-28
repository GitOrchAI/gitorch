-- A tabela-base do desejo (wishlist): pedidos gravados via Telegram (e,
-- futuramente, outras origens) para o usuário revisar depois e decidir a
-- qual projeto pertencem. Ver apps/control-plane/src/lib/wishlist-service.ts.
--
-- INCIDENTE 28/09/2026: o PR #898 (commit 43313969) adicionou `model
-- WishlistItem` ao schema.prisma sem nunca gerar a migração SQL do CREATE
-- TABLE correspondente — só multi-repo-wishlist-migration.sql chegou a
-- existir, e ele só roda ALTER TABLE ... ADD COLUMN IF NOT EXISTS em cima de
-- uma "wishlist_items" que nunca foi criada em produção. Todo deploy da main
-- quebrava: scripts/db-migrate.sh roda no ExecStartPre do systemd, tenta essa
-- ALTER TABLE contra uma tabela inexistente e morre — qualquer restart do
-- serviço com a main daquele estado falhava.
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado —
--   scripts/db-migrate.sh
--   psql "$DATABASE_URL" -f prisma/wishlist-migration.sql
--
-- Aditiva e idempotente: CREATE TABLE/INDEX guardados por IF NOT EXISTS; a FK
-- usa o mesmo padrão idempotente de incremento-migration.sql e
-- project-invitation-migration.sql (DROP CONSTRAINT IF EXISTS seguido de ADD
-- CONSTRAINT — Postgres não tem "ADD CONSTRAINT IF NOT EXISTS"). PRECISA vir
-- ANTES de multi-repo-wishlist-migration.sql no ledger: aquele arquivo só
-- adiciona colunas nesta tabela.
CREATE TABLE IF NOT EXISTS "wishlist_items" (
  "id"         TEXT NOT NULL,
  "user_id"    TEXT NOT NULL,
  "source"     TEXT NOT NULL,
  "payload"    TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wishlist_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "wishlist_items_user_id_idx"
  ON "wishlist_items" ("user_id");

ALTER TABLE "wishlist_items" DROP CONSTRAINT IF EXISTS "wishlist_items_user_id_fkey";
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
