-- Correção do bug de TIMING do W1 (ver PR fix/w1-bootstrap-timing): desacopla
-- o progresso do bootstrap de recursos do campo `status` (ciclo de vida do
-- wizard: provisional/fixed). Antes desta coluna, `bootstrapResources`
-- escrevia 'provisioning'/'ready'/'error' no PRÓPRIO `status` — e como o
-- bootstrap agora dispara cedo (no clone, passo 4/5, não só no submit final,
-- passo 10), um ambiente ainda em pleno wizard saía de 'provisional' NO MEIO
-- do processo. `fix()`/`createProvisional()` (que filtram `status:
-- 'provisional'`) paravam de reconhecer o ambiente — o aceite final nunca
-- fixava — e pior: `listExpired()` (a faxina de 24h que apaga ambiente
-- ABANDONADO com credencial/OAuth em disco — requisito de SEGURANÇA) também
-- parava de enxergá-lo, deixando escapar credencial órfã.
--
-- Esta coluna nova (`resources_status`) passa a ser a ÚNICA escrita pelo
-- bootstrap; `status` volta a significar SÓ o ciclo de vida.
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado, rode
-- UM dos dois:
--   npx prisma db push          # caminho normal do projeto (recomendado)
--   psql "$DATABASE_URL" -f prisma/resources-status-migration.sql   # este SQL direto

ALTER TABLE "client_environments"
  ADD COLUMN IF NOT EXISTS "resources_status" TEXT;
