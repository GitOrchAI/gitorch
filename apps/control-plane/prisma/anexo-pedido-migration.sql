-- CreateTable
CREATE TABLE IF NOT EXISTS "wish_attachments" (
    "id" TEXT NOT NULL,
    "wish_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "file_hash" TEXT NOT NULL,
    "text_content" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wish_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "wish_attachments_wish_id_idx" ON "wish_attachments"("wish_id");

-- AddForeignKey
ALTER TABLE "wish_attachments" DROP CONSTRAINT IF EXISTS "wish_attachments_wish_id_fkey";
ALTER TABLE "wish_attachments" ADD CONSTRAINT "wish_attachments_wish_id_fkey" FOREIGN KEY ("wish_id") REFERENCES "wishlist_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
