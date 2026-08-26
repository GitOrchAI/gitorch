-- O aviso de publicação do CD do cliente (D50) — ADITIVA e não-destrutiva.
--
-- POR QUÊ: um projeto que publica fora do GitHub (VM do cliente, serviço
-- externo que não registra nada) não tem como ser confirmado de fora. A rota
-- POST /api/projects/:id/publicado existe para receber esse aviso, mas o CD do
-- cliente não sabe que ela existe — e alguém precisa pôr a chamada lá.
--
-- Decisão do dono em 26/08: esse alguém é o PRODUTO, não o executor. Um dos
-- agentes percebe, abre a tarefa no repositório do cliente e delega ao dev
-- assíncrono. Se um humano remendasse na mão, o produto continuaria incapaz e
-- o próximo cliente cairia no mesmo buraco.
--
-- `deploy_notice_installed_at` é a PROVA de que a chamada existe e funciona:
-- gravado na primeira vez que um aviso chega de verdade. `deploy_notice_asked_key`
-- é o dedup do pedido — sem ele, uma issue por tique no repositório do cliente.
--
-- COMO APLICAR: a partir de apps/control-plane, com DATABASE_URL no ambiente:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/aviso-de-publicacao-migration.sql
-- (ou via apps/control-plane/scripts/db-migrate.sh, que reconcilia o ledger inteiro)

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "deploy_notice_installed_at" TIMESTAMP(3);
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "deploy_notice_asked_key" TEXT;
