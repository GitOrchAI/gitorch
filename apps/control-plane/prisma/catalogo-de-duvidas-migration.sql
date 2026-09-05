-- L5-T5 (D75, 05/09) — decisão do dono, palavras dele: "os agentes do
-- gitorch nao podem mandar essas duvidas pra mim, o jules (DEV assincrono)
-- eles (QA, SM, PO e RA) algum deles tem que resolver isso, responder o
-- jules. E não passar por mim [...] tem que ter sistema que coleta todas
-- essas duvidas pra que nas proximas tasks o RA e PO não gere duvidas e
-- sempre melhore".
--
-- Catálogo de conversa entre o dev assíncrono (Jules) e o TIME: cada
-- pergunta do dev (`agentMessaged` na API do Jules, originator='agent') e
-- cada resposta que o TIME mandou (`userMessaged`, originator='user'), uma
-- linha por mensagem. `escalar-duvida-ao-dono.ts` grava aqui em vez de criar
-- `agent_question` — o caminho da dúvida do dev até o dono foi fechado nesta
-- mesma tarefa.
--
-- `session_name`/`issue_number` são descritivos (sem FK): a sessão do dev
-- assíncrono é identidade EXTERNA (Jules), mesmo padrão de
-- `infra_incidents.issue_number`/`pr_number` (nenhuma FK local também).
--
-- O índice único (session_name, originator, momento) é o que torna a
-- gravação IDEMPOTENTE: a mesma sessão é relida a cada tique enquanto espera
-- resposta do dev, e `registrarConversaDaSessao` (catalogo-de-duvidas.ts)
-- grava com `createMany({ skipDuplicates: true })` — sem este índice, cada
-- releitura duplicaria as mensagens já conhecidas.
--
-- COMO APLICAR: a partir de apps/control-plane, com DATABASE_URL no ambiente:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/catalogo-de-duvidas-migration.sql
-- (ou via apps/control-plane/scripts/db-migrate.sh, que reconcilia o ledger inteiro)

CREATE TABLE IF NOT EXISTS catalogo_de_duvidas (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  session_name TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  originator   TEXT NOT NULL,
  texto        TEXT NOT NULL,
  momento      TIMESTAMP(3) NOT NULL,
  created_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS catalogo_de_duvidas_sessao_msg_key
  ON catalogo_de_duvidas (session_name, originator, momento);

CREATE INDEX IF NOT EXISTS catalogo_de_duvidas_project_idx
  ON catalogo_de_duvidas (project_id);
