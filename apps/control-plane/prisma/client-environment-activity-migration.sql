-- A faxina de 24h passa a medir INATIVIDADE, não idade.
--
-- POR QUÊ: o garbage collector varria `client_environments` com
-- status='provisional' AND created_at < now() - 24h. Como `created_at` nunca era
-- renovado (createProvisional reusa a linha existente sem tocar na data), quem
-- aceitava os termos, conectava os motores e voltava pra terminar o wizard
-- depois de 24h tinha o ambiente DESTRUÍDO no meio do cadastro — junto com o
-- clone e as credenciais que o CLI gravou no HOME (dir 0700).
--
-- A faxina continua existindo (é requisito de SEGURANÇA: ambiente abandonado
-- guarda credencial + OAuth do cliente): o que muda é o relógio. Agora ela corta
-- por `last_activity_at`, renovado a cada atividade real do cliente no wizard.
--
-- COMO APLICAR: a partir de apps/control-plane, com o
-- .env carregado, rode UM dos dois:
--   npx prisma db push          # caminho normal do projeto (recomendado)
--   psql "$DATABASE_URL" -f prisma/client-environment-activity-migration.sql   # este SQL direto

-- 1. A coluna nasce anulável para poder fazer o backfill das linhas existentes.
ALTER TABLE "client_environments"
  ADD COLUMN IF NOT EXISTS "last_activity_at" TIMESTAMP(3);

-- 2. Backfill: a melhor evidência de atividade que temos das linhas antigas é a
--    escrita mais recente nelas. Sem isto, todo ambiente vivo entraria na
--    próxima varredura como "sem atividade desde sempre" e seria destruído.
UPDATE "client_environments"
   SET "last_activity_at" = GREATEST("created_at", "updated_at")
 WHERE "last_activity_at" IS NULL;

-- 3. Agora sim: NOT NULL + default, o contrato que o schema.prisma declara.
ALTER TABLE "client_environments"
  ALTER COLUMN "last_activity_at" SET DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "client_environments"
  ALTER COLUMN "last_activity_at" SET NOT NULL;

-- 4. O índice que o GC realmente usa agora. O antigo (status, created_at) deixa
--    de servir ao corte — sai para não custar escrita à toa.
CREATE INDEX IF NOT EXISTS "client_environments_status_last_activity_at_idx"
  ON "client_environments" ("status", "last_activity_at");
DROP INDEX IF EXISTS "client_environments_status_created_at_idx";
