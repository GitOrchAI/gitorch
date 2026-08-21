-- A publicação que falha vira tarefa de conserto no repositório do cliente.
--
-- `deploy_fix_key`: a marca de dedup da tarefa de conserto já aberta para
-- esta sessão (`gitorch:conserto:<origem>:<commit>`). Sem ela, uma
-- publicação que falha — reexaminada a CADA varredura — abriria uma issue
-- por tique no repositório do cliente.
--
-- `env_last_verdict`: o veredito da ÚLTIMA leitura do ambiente publicado.
-- Existe só para exigir repetição antes de abrir tarefa por ambiente
-- inalcançável: uma leitura só não separa serviço fora do ar de queda de
-- rede momentânea.
--
-- Aditiva e idempotente: pode rodar em banco já povoado.
ALTER TABLE dev_sessions ADD COLUMN IF NOT EXISTS deploy_fix_key TEXT;
ALTER TABLE dev_sessions ADD COLUMN IF NOT EXISTS env_last_verdict TEXT;
