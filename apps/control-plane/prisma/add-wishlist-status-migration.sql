ALTER TABLE "wishlist_items" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "wishlist_items" ADD COLUMN "title" TEXT;
ALTER TABLE "wishlist_items" ADD COLUMN "price" DOUBLE PRECISION;
