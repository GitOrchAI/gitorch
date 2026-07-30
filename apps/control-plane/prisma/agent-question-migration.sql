-- Dúvida registrada por um agente (human-in-the-loop, épico W3) — ADITIVA e
-- não-destrutiva (só cria).
--
-- POR QUÊ: quando um agente esbarra numa decisão de rumo NÃO documentada
-- (ex.: 3 páginas com cores diferentes — "qual é a cor oficial do site?"), ele
-- precisa registrar a dúvida em vez de travar o pipeline. Esta tabela é a
-- fonte ÚNICA consumida pelo painel e pelo Telegram (ver
-- docs/superpowers/specs/2026-07-21-w3-telegram-duvidas-design.md). Quando o
-- dono responde, a decisão vira memória (Cortex) e o agente nunca mais
-- pergunta a mesma coisa (dedup_key).
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado, rode
-- UM dos dois:
--   npx prisma db push          # caminho normal do projeto (recomendado)
--   psql "$DATABASE_URL" -f prisma/agent-question-migration.sql   # este SQL direto

CREATE TABLE IF NOT EXISTS "agent_questions" (
  "id"                  TEXT NOT NULL,
  "project_id"          TEXT NOT NULL,
  "user_id"             TEXT NOT NULL,
  "text"                TEXT NOT NULL,
  "context"             TEXT,
  -- Array de {label, value} — vira os botões no Telegram; vazio = pergunta
  -- aberta (texto livre).
  "options"             JSONB NOT NULL DEFAULT '[]',
  "dedup_key"           TEXT,
  "status"              TEXT NOT NULL DEFAULT 'open',
  "answer"              TEXT,
  "answered_at"         TIMESTAMP(3),
  "answered_via"        TEXT,
  "telegram_message_id" INTEGER,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_questions_pkey" PRIMARY KEY ("id")
);

-- Painel: "abertas primeiro" por projeto — filtro quente de listOpen/listForUser.
CREATE INDEX IF NOT EXISTS "agent_questions_project_id_status_idx"
  ON "agent_questions" ("project_id", "status");

-- ask(): busca por dedup_key (escopada ao projeto na query) antes de criar —
-- não é único: a mesma chave pode repetir entre projetos e entre uma
-- pergunta aberta nova e a respondida antiga do mesmo projeto.
CREATE INDEX IF NOT EXISTS "agent_questions_dedup_key_idx"
  ON "agent_questions" ("dedup_key");

-- Projeto some -> as dúvidas dele somem junto (mesmo padrão de Event/ApiKey).
ALTER TABLE "agent_questions"
  DROP CONSTRAINT IF EXISTS "agent_questions_project_id_fkey";
ALTER TABLE "agent_questions"
  ADD CONSTRAINT "agent_questions_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
