-- O catálogo de modelos passa a ser coletado pelo RELÓGIO, e o modelo que sai
-- do catálogo passa a ficar MARCADO em vez de sumir.
--
-- O QUE FOI MEDIDO (01/09/2026 03:00, este banco):
--
--   runtime     | status    | modelos | models_refreshed_at
--   antigravity | connected |      14 | 2026-08-31 16:12:26
--   claude      | connected |      10 | 2026-08-28 03:38:16
--
-- e, no mesmo instante, `agy models` nesta VM devolve 11 modelos, nenhum da
-- geração 3.5. O catálogo do claude estava parado havia QUATRO DIAS. A causa é
-- `refreshModels` só rodar depois de uma missão COMPLETAR — com os motores
-- caindo, quase nenhuma completa, e a coleta só acontece quando já não
-- adianta. É o mesmo defeito que a cota teve até 30/08, um degrau mais fundo:
-- aqui o dado velho não desatualiza um painel, ele APROVA um modelo morto na
-- hora de escolher com o que a missão roda.
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado —
--   scripts/db-migrate.sh
--
-- ADITIVA e IDEMPOTENTE. As duas colunas nascem NULAS, e nulo tem significado
-- definido nos dois casos (ver abaixo) — nenhuma linha existente muda de
-- comportamento por causa desta migração.

BEGIN;

-- Quando a coleta foi TENTADA — sucesso ou fracasso. É de propósito uma coluna
-- separada de `models_refreshed_at`, que continua significando "quando um
-- catálogo novo de verdade substituiu o anterior".
--
-- Sem essa separação, o relógio olharia o carimbo de SUCESSO: um motor cuja
-- coleta falha sempre (rede fora, binário ausente) nunca seria carimbado,
-- ficaria eternamente vencido e seria tentado a cada tique de um minuto — uma
-- tempestade de containers escondida atrás de uma boa intenção. É exatamente
-- essa a forma do gêmeo da cota (`quota_refreshed_at`, carimbado só quando
-- algum número veio) e por isso ela não foi copiada aqui.
--
-- NULO = nunca tentado, e o relógio coleta na primeira passada. É o que
-- acontece com todas as linhas que já existem, e é o comportamento certo: são
-- justamente elas que estão com catálogo velho.
ALTER TABLE engine_connections ADD COLUMN IF NOT EXISTS models_checked_at TIMESTAMP(3);

-- Os modelos que SAÍRAM do catálogo do provedor, com a data em que a coleta
-- percebeu: [{"nome": "...", "sumiuEm": "2026-08-31T23:00:00.000Z"}].
--
-- Apagar não serve. Quem escolheu aquele modelo — no runtime_config do projeto
-- ou pelo painel — precisa saber que ele saiu e HÁ QUANTO TEMPO. Uma lista que
-- só encolhe leva a informação embora junto: o modelo some da tela e ninguém
-- liga a queda das missões à remoção do provedor. Foi literalmente o que
-- aconteceu em 31/08 — 24 missões mortas em 9h48 com `invalid model selection`
-- e nenhuma linha em lugar nenhum dizendo que a geração 3.5 tinha sido
-- removida.
--
-- NULO = nunca houve coleta bem-sucedida para comparar, que é diferente de
-- "nenhum modelo saiu" (lista vazia). A diferença importa: só a coleta que deu
-- certo prova ausência. Uma que falhou não prova nada e não escreve aqui.
ALTER TABLE engine_connections ADD COLUMN IF NOT EXISTS models_unavailable JSONB;

COMMIT;
