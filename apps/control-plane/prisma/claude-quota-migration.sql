-- Correção de erro real (o dono rejeitou a legenda "cota gerenciada pela sua
-- assinatura" — "sobre quota nao aceito isso... tem que coletar!"): existe uma
-- forma real de coletar a quota do Claude, `claude -p "/usage"` (ver
-- quota-reader.ts/parseClaudeUsageText). Ela não devolve um saldo
-- remaining/total como Codex/Antigravity — devolve % USADO de DUAS janelas
-- independentes (sessão de ~5h corridas e semana, todos os modelos) mais o
-- horário de reset de cada uma. Forçar isso em quota_remaining/quota_total
-- inventaria um número que não existe; por isso 4 colunas novas, só o
-- runtime 'claude' as popula.
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado, rode
-- UM dos dois:
--   npx prisma db push          # caminho normal do projeto (recomendado)
--   psql "$DATABASE_URL" -f prisma/claude-quota-migration.sql   # este SQL direto

ALTER TABLE "engine_connections"
  ADD COLUMN IF NOT EXISTS "session_percent_used" INTEGER,
  ADD COLUMN IF NOT EXISTS "session_resets_at" TEXT,
  ADD COLUMN IF NOT EXISTS "week_percent_used" INTEGER,
  ADD COLUMN IF NOT EXISTS "week_resets_at" TEXT;
