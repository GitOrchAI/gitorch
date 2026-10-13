-- Trava de entrega — ADITIVA e idempotente.
--
-- POR QUÊ: a troca de versão do produto nunca pode cortar um agente que está
-- trabalhando. Antes de trocar, o entregador pede que o produto pare de
-- INICIAR trabalho novo (a trava), espera o que está em andamento terminar e
-- só então troca. A trava precisa sobreviver a um reinício do serviço: uma
-- trava só em memória sumiria no restart que a própria troca provoca.
--
-- Linha única (id fixo 'entrega'). `desde` e `motivo` existem para o painel
-- dizer desde quando a atualização está em andamento e para o aviso de trava
-- esquecida; `ligada_por` registra quem pediu.
--
-- COMO APLICAR: a partir de apps/control-plane, com DATABASE_URL no ambiente:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/trava-de-entrega-migration.sql
-- (ou via apps/control-plane/scripts/db-migrate.sh, que reconcilia o ledger inteiro)

CREATE TABLE IF NOT EXISTS trava_de_entrega (
  id          TEXT PRIMARY KEY,
  ligada      BOOLEAN NOT NULL DEFAULT false,
  desde       TIMESTAMP(3),
  motivo      TEXT,
  ligada_por  TEXT,
  updated_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
