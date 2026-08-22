-- O pedido de retrabalho que não chegou ao dev vira pendência DURÁVEL.
--
-- Medido em 21/08/2026, na prova ponta a ponta: o QA reprovou o PR #157, a
-- entrega da reprovação na sessão do dev falhou com HTTP 429, o produto gritou
-- no log a frase certa ("o dev não vai retrabalhar sozinho") e NÃO REPETIU. O
-- encalhe é permanente por composição: o parecer já foi postado no PR, então o
-- laço de descoberta passa a tratar a entrega como "já julgada neste head" e
-- pula para sempre. Reenviado à mão às 17:52, o mesmo recado foi aceito na
-- hora (HTTP 200) — ou seja, uma simples repetição teria resolvido.
--
-- `rework_notice_pending`: o texto INTEIRO do pedido. Um booleano não serve:
-- a reentrega precisa do recado, não do aviso de que existiu um recado.
-- `rework_notice_attempts`: o teto, para um serviço fora do ar não virar laço.
--
-- Aditiva e idempotente: pode rodar em banco já povoado.
ALTER TABLE dev_sessions ADD COLUMN IF NOT EXISTS rework_notice_pending TEXT;
ALTER TABLE dev_sessions ADD COLUMN IF NOT EXISTS rework_notice_attempts SMALLINT NOT NULL DEFAULT 0;
