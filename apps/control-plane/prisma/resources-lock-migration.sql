-- Bootstrap de recursos versionados no ambiente (W1.2.2): o control-plane
-- agora INSTALA os motores/recursos pinados do manifesto DENTRO do ambiente
-- do cliente (infra/bootstrap-env.sh), não só clona os repos. Esta coluna
-- guarda o env-lock.json gerado pelo script (ClientEnvironmentService.
-- bootstrapResources) — auditável, para o wizard/painel mostrar ao dono o
-- que está realmente instalado. null enquanto o bootstrap não rodou ainda
-- ou falhou (o status vira 'error' nesse caso; NUNCA um ambiente "pronto"
-- sem os recursos de verdade instalados).
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado, rode
-- UM dos dois:
--   npx prisma db push          # caminho normal do projeto (recomendado)
--   psql "$DATABASE_URL" -f prisma/resources-lock-migration.sql   # este SQL direto

ALTER TABLE "client_environments"
  ADD COLUMN IF NOT EXISTS "resources_lock" JSONB;
