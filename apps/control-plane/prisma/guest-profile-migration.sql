-- CreateTable
CREATE TABLE "guest_profiles" (
    "id" TEXT NOT NULL,
    "invitation_id" TEXT NOT NULL,
    "encrypted_tokens" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guest_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "guest_profiles_invitation_id_key" ON "guest_profiles"("invitation_id");

-- AddForeignKey
ALTER TABLE "guest_profiles" ADD CONSTRAINT "guest_profiles_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "project_invitations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
