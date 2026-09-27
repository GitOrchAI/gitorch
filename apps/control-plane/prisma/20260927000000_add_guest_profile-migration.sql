-- CreateTable
CREATE TABLE "guest_profiles" (
    "id" TEXT NOT NULL,
    "invitation_token" TEXT NOT NULL,
    "encrypted_credentials" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guest_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "guest_profiles_invitation_token_key" ON "guest_profiles"("invitation_token");
