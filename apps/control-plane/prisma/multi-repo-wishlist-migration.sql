ALTER TABLE "wishlist_items" ADD COLUMN "target_repository_ids" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "wishlist_items" ADD COLUMN "is_cross_repo" BOOLEAN NOT NULL DEFAULT false;
