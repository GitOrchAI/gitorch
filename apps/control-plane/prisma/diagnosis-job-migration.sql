-- Diagnóstico grátis do setup wizard (F1) — ADITIVO e não-destrutivo (só cria; não dropa nada).
--
-- COMO APLICAR: a partir de apps/control-plane, com o
-- .env carregado, rode UM dos dois:
--   npx prisma db push          # caminho normal do projeto (recomendado)
--   psql "$DATABASE_URL" -f prisma/diagnosis-job-migration.sql   # este SQL direto

CREATE TABLE IF NOT EXISTS "diagnosis_jobs" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "repo_full_name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "progress" TEXT,
  "result" JSONB,
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3)
);

CREATE INDEX IF NOT EXISTS "diagnosis_jobs_user_id_repo_full_name_idx"
  ON "diagnosis_jobs" ("user_id", "repo_full_name");
