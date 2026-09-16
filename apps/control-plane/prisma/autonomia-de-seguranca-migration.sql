-- Até onde o GitOrch vai em SEGURANÇA sozinho, por projeto — campo próprio,
-- separado de `autonomia` (packages/cadence/src/autonomia.ts): o dono pode
-- querer "cuidar" em segurança (aplicar branch protection, ligar secret
-- scanning) sem abrir o resto do repositório no mesmo nível.
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado —
--   scripts/db-migrate.sh
--   psql "$DATABASE_URL" -f prisma/autonomia-de-seguranca-migration.sql

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS autonomia_de_seguranca TEXT NOT NULL DEFAULT 'so_olhar';

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_autonomia_de_seguranca_check;
ALTER TABLE projects ADD CONSTRAINT projects_autonomia_de_seguranca_check
  CHECK (autonomia_de_seguranca IN ('so_olhar', 'sugerir', 'cuidar'));

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS autonomia_de_seguranca_escolhida_em TIMESTAMP(3);
