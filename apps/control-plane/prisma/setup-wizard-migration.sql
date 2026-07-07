-- Setup Wizard redesign schema — ADITIVO e não-destrutivo (só cria; não dropa nada).
-- Suporta a conexão real dos 3 motores (Claude/Codex/Antigravity).
--
-- COMO APLICAR: a partir de apps/control-plane, com o
-- .env carregado, rode UM dos dois:
--   npx prisma db push          # caminho normal do projeto (recomendado)
--   psql "$DATABASE_URL" -f prisma/setup-wizard-migration.sql   # este SQL direto

ALTER TABLE "engine_connections" ADD COLUMN IF NOT EXISTS "credential_kind" TEXT DEFAULT 'file';
ALTER TABLE "engine_connections" ADD COLUMN IF NOT EXISTS "env_var_name" TEXT;
ALTER TABLE "engine_connections" ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMP(3);
