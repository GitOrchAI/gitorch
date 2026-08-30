-- O Incremento: o registro de que uma entrega ficou PRONTA, e quando.
--
-- POR QUÊ: o produto sabia que um PR foi mesclado e sabia se a publicação foi
-- ao ar, e nunca juntava as duas coisas em "isto ficou pronto". O painel não
-- tinha o que mostrar em Entregas, e o dono não tinha como responder "o que
-- vocês entregaram esta semana?" sem abrir o GitHub.
--
-- Scrum 2020: o Incremento nasce quando um item atende à Definição de Pronto.
-- A régua é do CLIENTE (decisão do dono, 6.1) e mora em `projects`; o veredito
-- de cada entrega mora aqui.
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado —
--   scripts/db-migrate.sh
--   psql "$DATABASE_URL" -f prisma/incremento-migration.sql
--
-- ADITIVA. Nenhuma linha existente muda de comportamento: a tabela nasce vazia
-- e a régua nasce nula, que o código lê como "use o padrão do produto".

BEGIN;

-- A régua daquele cliente, por projeto. NULO = ainda não configurou, vale o
-- padrão de packages/cadence/src/incremento.ts. Guardar o padrão aqui como
-- cópia apagaria a diferença entre "ele escolheu isto" e "ninguém escolheu" —
-- a mesma distinção que a autonomia precisou fazer.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS regua_de_pronto JSONB;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS regua_escolhida_em TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "increments" (
  "id"                TEXT NOT NULL,
  "project_id"        TEXT NOT NULL,
  -- O pedido do cliente (a issue). É por ele que o painel liga a entrega ao
  -- que o dono pediu, e não por um id interno que ele nunca viu.
  "issue_number"      INTEGER NOT NULL,
  -- A entrega que fechou o item. Nulo em pedido que fechou sem PR.
  "pull_request_number" INTEGER,
  "merge_commit_sha"  TEXT,
  -- Quando ficou pronto, pela régua. É a data que o painel mostra.
  "pronto_em"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- A régua que estava valendo NAQUELE momento, copiada. Sem isto, mudar a
  -- régua hoje reescreveria a história: uma entrega de ontem passaria a
  -- parecer que atendeu critérios que ninguém exigia dela.
  "regua_aplicada"    JSONB NOT NULL,
  -- Os critérios que passaram, na ordem da régua.
  "criterios"         JSONB NOT NULL,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "increments_pkey" PRIMARY KEY ("id")
);

-- Um pedido vira Incremento UMA vez. Sem isto, cada volta do relógio gravaria
-- outro registro da mesma entrega e o painel contaria a mesma coisa várias
-- vezes — o dono veria um número que só cresce e não quer dizer nada.
CREATE UNIQUE INDEX IF NOT EXISTS "increments_project_issue_key"
  ON "increments" ("project_id", "issue_number");

-- O painel lista por projeto, do mais recente para o mais antigo.
CREATE INDEX IF NOT EXISTS "increments_project_pronto_idx"
  ON "increments" ("project_id", "pronto_em" DESC);

ALTER TABLE "increments" DROP CONSTRAINT IF EXISTS "increments_project_id_fkey";
ALTER TABLE "increments" ADD CONSTRAINT "increments_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
