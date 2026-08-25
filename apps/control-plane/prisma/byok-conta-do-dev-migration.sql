-- BYOK do dev assíncrono (D34) — ADITIVA e não-destrutiva (só adiciona colunas
-- e índices).
--
-- POR QUÊ: o teto do dev assíncrono é da CONTA, não do projeto — no plano Pro
-- são 100 sessões em 24h e 15 ao mesmo tempo, divididas entre TODOS os
-- repositórios daquela conta. Com uma conta só, a do dono da instância, dois
-- clientes já estouram o teto e a recusa vira rotina. Com a conta do próprio
-- cliente, cada um traz o seu teto e a escala deixa de ser uma divisão.
--
-- `encrypted_dev_api_key` guarda a credencial do cliente cifrada (mesmo
-- caminho das credenciais dos motores de IA — ver lib/credential-crypto.ts);
-- NUNCA em texto puro. `dev_account_id` é a IMPRESSÃO DIGITAL dessa chave
-- (sha256 truncado), não o segredo: é por ela que o produto soma o teto dos
-- projetos do mesmo cliente sem precisar decifrar credencial nenhuma.
--
-- `dev_sessions.dev_account_id` grava em QUAL conta cada sessão nasceu. Sem
-- isso, trocar ou desconectar a conta do projeto faria o produto consultar,
-- avisar e arquivar sessões vivas com a chave errada (404 no fornecedor, vaga
-- presa para sempre na conta que o cliente paga) e faria o teto novo do
-- cliente nascer consumido por trabalho que nunca tocou a conta dele.
-- Nulo = conta da instância, que é o caso de todas as linhas anteriores ao BYOK.
--
-- COMO APLICAR: a partir de apps/control-plane, com DATABASE_URL no ambiente:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/byok-conta-do-dev-migration.sql
-- (ou via apps/control-plane/scripts/db-migrate.sh, que reconcilia o ledger inteiro)

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "encrypted_dev_api_key" TEXT;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "dev_account_id" TEXT;

-- A pergunta "quais projetos dividem esta conta" roda a cada acordada do SM.
CREATE INDEX IF NOT EXISTS "projects_dev_account_id_idx" ON "projects" ("dev_account_id");

ALTER TABLE "dev_sessions" ADD COLUMN IF NOT EXISTS "dev_account_id" TEXT;

-- A contagem do teto ("quantas sessões esta conta abriu nas últimas 24h" e
-- "quantas estão vivas agora") passa a filtrar por conta — sem índice, ela
-- varre a tabela inteira a cada delegação.
CREATE INDEX IF NOT EXISTS "dev_sessions_dev_account_id_idx" ON "dev_sessions" ("dev_account_id");
