-- Cache do grafo 3D do diagnóstico (F1) — ADITIVO e não-destrutivo (só cria; não dropa nada).
--
-- POR QUÊ: GET /api/v1/diagnose/:id/graph reprocessava o CGC do zero (~7-8s)
-- em TODA chamada — mesmo repetindo o mesmo job. Isso estourava o timeout de
-- rede do wizard (o dono acessa pela Tailscale, não localhost) e caía sempre
-- no fallback em tabela, mesmo com a rota respondendo 200 com o grafo real.
-- A coluna guarda o resultado do 1º export bem-sucedido; as próximas
-- chamadas pro mesmo job devolvem instantâneo, sem rodar o CGC de novo.
--
-- COMO APLICAR: a partir de apps/control-plane, com o
-- .env carregado, rode UM dos dois:
--   npx prisma db push          # caminho normal do projeto (recomendado)
--   psql "$DATABASE_URL" -f prisma/graph-cache-migration.sql   # este SQL direto

ALTER TABLE "diagnosis_jobs"
  ADD COLUMN IF NOT EXISTS "graph" JSONB;
