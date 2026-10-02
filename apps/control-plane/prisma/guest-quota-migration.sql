-- AlterTable
-- guest-quota-migration.sql

ALTER TABLE "project_invitations" ADD COLUMN IF NOT EXISTS "used_quota" INTEGER NOT NULL DEFAULT 0;
