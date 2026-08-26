-- AlterTable
ALTER TABLE "missions" ADD COLUMN IF NOT EXISTS "waiting_reason" TEXT,
ADD COLUMN IF NOT EXISTS "waiting_status" TEXT;
