-- Billing schema — ADITIVO e não-destrutivo (só cria; não dropa nada).
-- Gerado 2026-07-06 para a Fase B (billing geo/PPP).
--
-- COMO APLICAR (owner, quando aprovar): a partir de apps/control-plane, com o
-- .env carregado, rode UM dos dois:
--   npx prisma db push          # caminho normal do projeto (recomendado)
--   psql "$DATABASE_URL" -f prisma/billing-migration.sql   # este SQL direto
-- Depois: npx tsx prisma/seed.ts   (upsert dos 4 planos free/solo/pro/team)
-- E rode o script de preços Stripe: npx tsx scripts/stripe-sync-prices.ts

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_customer_id" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "users_stripe_customer_id_key" ON "users"("stripe_customer_id");

ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "tier_rank" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "max_concurrent_missions" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "seats" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "plans" ADD COLUMN IF NOT EXISTS "features" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS "plan_prices" (
  "id" TEXT PRIMARY KEY,
  "plan_id" TEXT NOT NULL REFERENCES "plans"("id") ON DELETE CASCADE,
  "tier" TEXT NOT NULL,
  "currency" TEXT NOT NULL,
  "unit_amount" INTEGER NOT NULL,
  "stripe_price_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "plan_prices_plan_id_tier_key" ON "plan_prices"("plan_id","tier");

CREATE TABLE IF NOT EXISTS "subscriptions" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL UNIQUE REFERENCES "users"("id") ON DELETE CASCADE,
  "stripe_subscription_id" TEXT NOT NULL UNIQUE,
  "plan_id" TEXT NOT NULL,
  "tier" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'incomplete',
  "current_period_end" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "waitlist" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE,
  "github_login" TEXT,
  "requested_plan_id" TEXT,
  "tier" TEXT,
  "country" TEXT,
  "status" TEXT NOT NULL DEFAULT 'waiting',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Controle de gasto (spend-guard): quota dos motores + tokens por missão.
ALTER TABLE "engine_connections" ADD COLUMN IF NOT EXISTS "quota_remaining" INTEGER;
ALTER TABLE "engine_connections" ADD COLUMN IF NOT EXISTS "quota_total" INTEGER;
ALTER TABLE "engine_connections" ADD COLUMN IF NOT EXISTS "quota_refreshed_at" TIMESTAMP(3);
ALTER TABLE "missions" ADD COLUMN IF NOT EXISTS "tokens_used" INTEGER;
