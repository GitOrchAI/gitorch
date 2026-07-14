-- Vínculo do Telegram do cliente — ADITIVO e não-destrutivo (só cria).
--
-- POR QUÊ: o passo 8 do wizard pedia o @username e o guardava em
-- `projects.runtime_config->telegram`. Ninguém lia esse campo — e nem adiantaria:
-- a API do Telegram (`sendMessage`) exige um `chat_id`, e um @username de pessoa
-- não endereça ninguém. O cliente informava o Telegram dele e NUNCA recebia
-- mensagem: a promessa era impossível por construção.
--
-- O `chat_id` só passa a existir quando a pessoa fala com o bot. Daí esta tabela:
-- o wizard gera um token de uso único, o cliente abre `t.me/<bot>?start=<token>`
-- e aperta Start, o bot recebe `/start <token>` e é nesse update que capturamos o
-- `chat_id` e o amarramos ao dono do token.
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado, rode UM dos dois:
--   npx prisma db push          # caminho normal do projeto (recomendado)
--   psql "$DATABASE_URL" -f prisma/telegram-link-migration.sql   # este SQL direto

CREATE TABLE IF NOT EXISTS "telegram_links" (
  "id"               TEXT NOT NULL,
  "user_id"          TEXT NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'pending',
  -- Token de uso único do deep link: consumido no vínculo (volta a NULL) e com
  -- validade. No Postgres NULLs são distintos entre si, então o UNIQUE abaixo
  -- convive com N vínculos já consumidos.
  "token"            TEXT,
  "token_expires_at" TIMESTAMP(3),
  -- Só existe depois do Start: é o endereço real que a API do Telegram exige.
  "chat_id"          TEXT,
  "linked_at"        TIMESTAMP(3),
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "telegram_links_pkey" PRIMARY KEY ("id")
);

-- Um vínculo por dono: é por `user_id` que o notificador acha o chat de quem
-- deve receber o aviso — nunca por repositório, nunca pelo chat da gitorch.
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_links_user_id_key"
  ON "telegram_links" ("user_id");

-- O /start chega com o token e nada mais: a busca por ele é o caminho quente.
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_links_token_key"
  ON "telegram_links" ("token");

-- Dono some -> vínculo some junto (o chat_id é dado pessoal dele).
ALTER TABLE "telegram_links"
  DROP CONSTRAINT IF EXISTS "telegram_links_user_id_fkey";
ALTER TABLE "telegram_links"
  ADD CONSTRAINT "telegram_links_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
