-- Projeto é do DONO: unicidade de `wing_id` deixa de ser GLOBAL e passa a ser
-- por usuário (user_id, wing_id).
--
-- POR QUÊ: `wing_id` guarda "owner/repo" — o endereço do REPOSITÓRIO (o
-- scheduler clona a partir dele; o webhook do GitHub casa `repository.full_name`
-- contra ele), não a chave do cliente. Sendo único GLOBAL, dois clientes não
-- podiam cadastrar o mesmo repositório: o segundo (ex.: outro colaborador de
-- "acme/api") ACHAVA o Project do primeiro no wizard e recebia uma ApiKey válida
-- sobre o projeto alheio — vazamento entre clientes.
--
-- COMO APLICAR: a partir de apps/control-plane, com o
-- .env carregado, rode UM dos dois:
--   npx prisma db push          # caminho normal do projeto (recomendado)
--   psql "$DATABASE_URL" -f prisma/project-owner-scope-migration.sql   # este SQL direto

-- 1. Cai o único GLOBAL de wing_id (o Prisma o criou como UNIQUE INDEX; a forma
--    de CONSTRAINT é tratada junto, por segurança — ambas são no-op se ausentes).
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_wing_id_key";
DROP INDEX IF EXISTS "projects_wing_id_key";

-- 2. Entra o único POR DONO. No Postgres NULLs são distintos entre si, então
--    linhas legadas sem dono (user_id NULL) não colidem entre si; todo projeto
--    novo nasce com dono (a rota de setup passou a exigir).
CREATE UNIQUE INDEX IF NOT EXISTS "projects_user_id_wing_id_key"
  ON "projects" ("user_id", "wing_id");

-- 3. O índice simples de wing_id CONTINUA existindo: é por ele que o webhook do
--    GitHub reencontra o projeto pelo full_name do repositório (o wizard não
--    preenche github_repo_id/github_installation_id).
CREATE INDEX IF NOT EXISTS "projects_wing_id_idx" ON "projects" ("wing_id");
