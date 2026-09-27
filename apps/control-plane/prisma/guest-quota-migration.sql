ALTER TABLE "project_invitations" ADD COLUMN IF NOT EXISTS "used_quota" INTEGER DEFAULT 0;
