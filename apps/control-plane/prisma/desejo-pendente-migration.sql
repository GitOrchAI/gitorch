-- O pedido de desejo que espera o dono dizer A QUAL PROJETO ele pertence.
--
-- Antes desta tabela a resposta à ambiguidade era um texto pedindo que a
-- pessoa escrevesse tudo de novo com o endereço do repositório na frente. O
-- dono tentou três vezes pelo chat e as três foram recusadas. A resposta agora
-- é um BOTÃO — e é o botão que exige esta tabela: entre a pergunta e o toque
-- passa tempo de gente, e o serviço reinicia várias vezes por dia. Guardado na
-- memória do processo, o pedido evaporaria antes do clique e a pessoa tocaria
-- no botão para receber silêncio. É a mesma armadilha que quase matou a
-- retrospectiva semanal.
--
-- `texto`: o pedido em linguagem de gente, inteiro. É isto que não pode se
-- perder — sem ele o clique não tem o que registrar.
-- `usado_em`: nulo enquanto espera; carimbado no instante em que vira issue,
-- para que uma reentrega do mesmo clique pelo Telegram não abra duas.
--
-- A lista de projetos NÃO é congelada aqui de propósito: ela é recalculada no
-- momento do clique, senão um projeto removido no meio do caminho ainda
-- valeria como opção.
--
-- Aditiva e idempotente: pode rodar em banco já povoado.
CREATE TABLE IF NOT EXISTS pedidos_de_desejo_pendentes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  chat_id    TEXT NOT NULL,
  texto      TEXT NOT NULL,
  usado_em   TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS pedidos_de_desejo_pendentes_user_id_chat_id_idx
  ON pedidos_de_desejo_pendentes (user_id, chat_id);
CREATE INDEX IF NOT EXISTS pedidos_de_desejo_pendentes_created_at_idx
  ON pedidos_de_desejo_pendentes (created_at);
