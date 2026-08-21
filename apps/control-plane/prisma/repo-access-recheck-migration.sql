-- Reconferência periódica do acesso ao repositório, por projeto.
--
-- O acesso era provado uma vez, no cadastro, e o caminho automático nunca mais
-- perguntava nada: removido do repositório depois, o dono continuava com o
-- relógio disparando missão e escrevendo lá com a credencial da instalação.
-- Estas colunas guardam o acompanhamento — quando foi conferido, se o projeto
-- está suspenso, por quê, e quantas conferências seguidas não concluíram nada.
--
-- Aditivo e idempotente: colunas nulas (e um contador com padrão zero), então
-- todo projeto existente entra como "nunca conferido" e é conferido no primeiro
-- ciclo depois do deploy. Nenhum projeto nasce suspenso por causa desta
-- migração.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS access_checked_at TIMESTAMP(3);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS access_suspended_at TIMESTAMP(3);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS access_suspended_reason TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS access_check_failures INTEGER NOT NULL DEFAULT 0;
