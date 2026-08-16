-- Acompanhamento do que acontece DEPOIS do merge, e da espera pela verificação.
--
-- As quatro primeiras colunas servem à Tarefa 7 (vigília ativa da verificação
-- automática, com teto de espera) e às Tarefas 12/13 (acompanhar a
-- publicação). As duas últimas preparam o terreno da Tarefa 10 (contar
-- fracassos de mescla) — criadas aqui para não exigir uma segunda migração;
-- esta migração NÃO as usa.
--
-- Aditivo e idempotente: pode rodar em banco já povoado.
ALTER TABLE dev_sessions ADD COLUMN IF NOT EXISTS pending_since TIMESTAMP(3);
ALTER TABLE dev_sessions ADD COLUMN IF NOT EXISTS merge_commit_sha TEXT;
ALTER TABLE dev_sessions ADD COLUMN IF NOT EXISTS deploy_state TEXT;
ALTER TABLE dev_sessions ADD COLUMN IF NOT EXISTS deploy_checked_at TIMESTAMP(3);
ALTER TABLE dev_sessions ADD COLUMN IF NOT EXISTS merge_failures SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE dev_sessions ADD COLUMN IF NOT EXISTS merge_last_failed_at TIMESTAMP(3);
