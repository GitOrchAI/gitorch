-- Os seis campos do desenho "A lógica da leva 2" (bloco 5, aprovado 30/08) que
-- a tabela `increments` ainda não tinha: { projeto · sprint · o que era ·
-- QUANTO PESAVA · QUEM TOCOU · PEDIDO SEU OU PROATIVO }. `projeto` já existia
-- via `project_id`; os outros cinco nasciam faltando, e por isso a tabela
-- tinha 0 linhas mesmo com entregas reais acontecendo (D3, medido em 01/09).
--
-- `wish_created_at` e `merged_at` também entram aqui: já estavam declarados
-- no schema.prisma desde o PR #405 ("for lead time calculations") mas SEM
-- migração correspondente — drift entre schema e banco, nunca aplicado. São
-- exatamente o INÍCIO e um marco do FIM que a medição do ciclo (D4) precisa:
-- o ciclo é do ITEM (do desejo até a entrega), não da sessão do dev.
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado —
--   scripts/db-migrate.sh
--   psql "$DATABASE_URL" -f prisma/incremento-campos-do-desenho-migration.sql
--
-- ADITIVA. Todas as colunas são NULLABLE ou nascem com DEFAULT que preserva o
-- comportamento anterior; nenhuma linha existente muda (a tabela está vazia
-- hoje, mas a regra vale de qualquer forma). Registro histórico não se
-- reescreve: o que já virou Incremento continua Incremento mesmo que a régua
-- mude depois.

BEGIN;

-- "O que era" — o título da issue, relido do GitHub no momento do registro.
ALTER TABLE "increments" ADD COLUMN IF NOT EXISTS "titulo" TEXT;

-- O nome do milestone nativo do GitHub ("Sprint 3"), que backlog-executor.ts
-- já grava via setMilestone. Nulo = a issue não tinha milestone quando a
-- entrega foi registrada.
ALTER TABLE "increments" ADD COLUMN IF NOT EXISTS "sprint" TEXT;

-- "Quanto pesava" — a mesma escala 1,2,3,5,8,13 que já vai pro corpo da
-- issue (## Peso, renderIssueBody). Nulo = task sem estimativa (issue de
-- conserto/aviso/incidente, que nunca passou pelo roteiro do PO).
ALTER TABLE "increments" ADD COLUMN IF NOT EXISTS "peso" SMALLINT;

-- "Quem tocou": só existe UM caminho de escrita hoje
-- (registrarPublicacaoEIncremento, scheduler.ts), e ele só roda para sessões
-- do dev assíncrono — por isso o default é 'gitorch'. Um futuro caminho para
-- merge feito à mão pelo dono gravaria 'dono' explicitamente.
ALTER TABLE "increments" ADD COLUMN IF NOT EXISTS "quem_tocou" TEXT NOT NULL DEFAULT 'gitorch';
ALTER TABLE "increments" DROP CONSTRAINT IF EXISTS "increments_quem_tocou_check";
ALTER TABLE "increments" ADD CONSTRAINT "increments_quem_tocou_check"
  CHECK ("quem_tocou" IN ('gitorch', 'dono'));

-- "Pedido seu ou proativo": nasceu de uma wish do dono (etiqueta `wishlist`,
-- a única porta de desejo — routes/index.ts e plugins/telegram.ts) ou o
-- produto criou a issue por conta própria (aviso/conserto de publicação).
-- 'desconhecido' é o default para nunca afirmar uma origem sem prova — só
-- vira 'pedido'/'proativo' quando o corpo da issue foi lido de verdade.
ALTER TABLE "increments" ADD COLUMN IF NOT EXISTS "pedido_ou_proativo" TEXT NOT NULL DEFAULT 'desconhecido';
ALTER TABLE "increments" DROP CONSTRAINT IF EXISTS "increments_pedido_ou_proativo_check";
ALTER TABLE "increments" ADD CONSTRAINT "increments_pedido_ou_proativo_check"
  CHECK ("pedido_ou_proativo" IN ('pedido', 'proativo', 'desconhecido'));

-- D4 — o INÍCIO do ciclo do ITEM: quando a wish nasceu (issue proativa: a
-- própria issue É a origem). Nulo = não deu para confirmar no GitHub no
-- momento do registro; o item fica de fora da medição, nunca com data
-- inventada.
ALTER TABLE "increments" ADD COLUMN IF NOT EXISTS "wish_created_at" TIMESTAMP(3);

-- Quando o PR mesclou (fato do GitHub, distinto de `pronto_em`, que é quando
-- a RÉGUA considerou pronto — pode ser depois do merge, ex.: esperando ir
-- ao ar).
ALTER TABLE "increments" ADD COLUMN IF NOT EXISTS "merged_at" TIMESTAMP(3);

COMMIT;
