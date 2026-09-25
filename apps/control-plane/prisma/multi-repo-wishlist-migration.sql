ALTER TABLE "wishlist_items" ADD COLUMN IF NOT EXISTS "target_repository_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "wishlist_items" ADD COLUMN IF NOT EXISTS "is_cross_repo" BOOLEAN NOT NULL DEFAULT false;
