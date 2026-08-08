-- Credencial do PRÓPRIO cliente, cifrada — ADITIVA e não-destrutiva (só adiciona
-- coluna).
--
-- POR QUÊ: a credencial do App do produto não alcança quadro de conta pessoal
-- nem nenhuma rota de segurança (ex.: Dependabot) — medido contra a API real.
-- Quando o projeto do cliente precisa de algo nessas rotas, a saída é o
-- próprio cliente fornecer sua credencial. Ela é usada só onde o App não
-- chega, nunca como atalho geral, e nunca é gravada em texto puro — sempre
-- cifrada antes de tocar o banco (ver apps/control-plane/src/lib/
-- credential-crypto.ts e apps/control-plane/src/services/
-- project-credential.ts).
--
-- COMO APLICAR: a partir de apps/control-plane, com DATABASE_URL no ambiente:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/client-token-migration.sql
-- (ou via apps/control-plane/scripts/db-migrate.sh, que reconcilia o ledger inteiro)

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "encrypted_client_token" TEXT;
