-- CreateTable
CREATE TABLE IF NOT EXISTS "project_invitations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "target_projects" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "project_invitations_user_id_idx" ON "project_invitations"("user_id");

-- AddForeignKey
ALTER TABLE "project_invitations" DROP CONSTRAINT IF EXISTS "project_invitations_user_id_fkey";
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
