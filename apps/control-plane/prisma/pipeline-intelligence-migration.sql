-- pipeline-intelligence-migration.sql
--
-- Tabelas dos modelos PipelineConfig e PipelineEvidence (PR #1038,
-- pipeline-intelligence), que estavam no schema.prisma sem nenhum SQL no
-- ledger: um banco migrado só pelo ledger não tinha as duas tabelas e as
-- rotas de routes/pipeline-routes.ts falhavam por tabela inexistente.
--
-- Aditiva e idempotente: só CREATE ... IF NOT EXISTS, e as chaves
-- estrangeiras só entram se ainda não existirem. Depende de `projects`
-- (baseline), por isso fica no fim do ledger.

-- CreateTable
CREATE TABLE IF NOT EXISTS "pipeline_configs" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "runner_preference" TEXT NOT NULL DEFAULT 'auto',
    "last_score" INTEGER,
    "last_audited_at" TIMESTAMP(3),
    "detected_stack" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "pipeline_evidences" (
    "id" TEXT NOT NULL,
    "pipeline_config_id" TEXT NOT NULL,
    "commit_hash" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "event_source" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "evidence_summary" JSONB NOT NULL,
    "collected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pipeline_evidences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_configs_project_id_key" ON "pipeline_configs"("project_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_evidences_pipeline_config_id_commit_hash_idx" ON "pipeline_evidences"("pipeline_config_id", "commit_hash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pipeline_evidences_commit_hash_idx" ON "pipeline_evidences"("commit_hash");

-- AddForeignKey (onDelete: Cascade, igual ao schema.prisma)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_configs_project_id_fkey') THEN
    ALTER TABLE "pipeline_configs" ADD CONSTRAINT "pipeline_configs_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_evidences_pipeline_config_id_fkey') THEN
    ALTER TABLE "pipeline_evidences" ADD CONSTRAINT "pipeline_evidences_pipeline_config_id_fkey"
      FOREIGN KEY ("pipeline_config_id") REFERENCES "pipeline_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
