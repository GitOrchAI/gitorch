-- Renovação automática do token do GitHub (F8): o login por GitHub App
-- (client_id Iv23..., "User-to-server token expiration" LIGADO) expira o
-- access_token a cada ~8h e entrega um refresh_token junto — que o código de
-- hoje descarta (auth.ts só lia access_token/error). Sem guardar o par,
-- nenhuma rotina automática consegue renovar, e a credencial morre sozinha
-- 8h depois de cada login.
--
-- Cifrado com o MESMO envelope AES-256-GCM de encrypted_credential (nunca
-- texto puro) — ver lib/credential-crypto.ts. Aditivo e idempotente: NULL em
-- toda linha existente hoje; a rotina de renovação
-- (services/github-token-refresh.ts) trata a ausência como "conexão legada,
-- precisa reconectar uma vez", nunca como "não expira".
ALTER TABLE "engine_connections"
  ADD COLUMN IF NOT EXISTS "encrypted_refresh_token" TEXT,
  ADD COLUMN IF NOT EXISTS "refresh_token_expires_at" TIMESTAMP(3);
