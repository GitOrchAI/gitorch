-- Identidade estável por githubId + instalação do GitHub App por usuário —
-- ADITIVO e não-destrutivo (só cria colunas/índices, nunca remove nada).
--
-- POR QUÊ (github_id): o login upsert atual (`auth.ts`) casa o usuário pelo
-- `github_login`. Um `login` pode ser renomeado — e o antigo username fica
-- livre para OUTRA conta do GitHub reivindicar. Sem uma âncora numérica,
-- quem "herdasse" um username abandonado herdaria, no gitorch, o User (e os
-- projetos) de quem o tinha antes: um takeover silencioso de conta. O id
-- numérico do GitHub nunca muda e nunca é reciclado — é BigInt porque contas
-- mais novas já passam do range de um Int de 32 bits.
--
-- POR QUÊ (github_installation_id): login atual usa OAuth App clássico com
-- escopo `repo` amplo (acesso a TODOS os repos da conta). A instalação do
-- GitHub App é escolhida pelo próprio usuário na tela de instalação do
-- GitHub (github.com/apps/<slug>/installations/new) — ele decide "todos os
-- repos" ou uma lista específica. Gravar qual instalação é dela permite que
-- GET /api/v1/github/repos liste só o que a pessoa realmente autorizou, em
-- vez de tudo que o token OAuth clássico enxerga. NÃO É a mesma coluna de
-- `projects.github_installation_id` (essa é por REPOSITÓRIO, usada pelo
-- webhook para casar eventos; esta aqui é por USUÁRIO).
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado, rode UM dos dois:
--   npx prisma db push          # caminho normal do projeto (recomendado)
--   psql "$DATABASE_URL" -f prisma/github-app-install-migration.sql   # este SQL direto

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "github_id" BIGINT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "github_installation_id" INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS "users_github_id_key"
  ON "users" ("github_id");
