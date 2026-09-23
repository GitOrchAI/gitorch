ALTER TABLE "project_invitations" ADD COLUMN IF NOT EXISTS "engine_mapping" JSONB, ADD COLUMN IF NOT EXISTS "execution_limits" JSONB;
