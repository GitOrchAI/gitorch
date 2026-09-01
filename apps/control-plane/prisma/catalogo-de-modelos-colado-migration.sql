-- O catálogo de modelos estava COLADO: slug e nome de exibição na mesma string.
--
-- O QUE ACONTECEU: `agy models` imprime `slug<TAB>Nome de Exibição` — conferido
-- nesta VM com `agy models | cat -A`. O coletor antigo (services/model-catalog.ts)
-- só fazia `split('\n')` + `trim()` e guardava a LINHA INTEIRA. Medido no banco em
-- 01/09/2026: as 14 entradas de `engine_connections.models` do antigravity estavam
-- todas no formato 'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)'.
--
-- POR QUE ISSO IMPORTA: o `--model` do agy aceita o NOME DE EXIBIÇÃO, não o slug e
-- muito menos os dois grudados. Provado ao vivo:
--   $ agy --model "Gemini 3.5 Flash (Medium)" -p "say ok"
--   Error: invalid model selection ... Available models: Gemini 3.7 Flash (High) ...
-- Ou seja: nenhuma das 14 entradas serviria como valor de --model. O catálogo era
-- bonito na tela e inútil para qualquer decisão — e agora que a escolha do modelo
-- da missão CONSULTA esse catálogo (modeloVivoParaAMissao, em plugins/scheduler.ts),
-- deixar as linhas coladas faria a guarda concluir "o modelo não existe" para
-- modelos que existem.
--
-- O coletor já foi consertado no mesmo commit; esta migração cuida das linhas que
-- JÁ estão no banco, que a coleta nova só reescreveria na próxima passagem.
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado —
--   scripts/db-migrate.sh
--
-- ADITIVA e IDEMPOTENTE: não altera schema nenhum. Só toca linhas que de fato têm
-- TAB — rodar de novo é no-op. Os outros dois motores (claude, codex) já gravavam
-- limpo (conferido no banco: 10 e 3 entradas, nenhuma com TAB) e NÃO são tocados,
-- justamente porque o critério é a presença do TAB, não o nome do motor.

BEGIN;

WITH alvo AS (
  -- Só linhas cujo `models` é de fato uma lista JSON. Qualquer outra forma
  -- (nulo, objeto, texto) fica de fora antes de qualquer expansão — expandir
  -- um não-array seria erro em tempo de execução, não dado a consertar.
  SELECT id, models
  FROM engine_connections
  WHERE models IS NOT NULL
    AND jsonb_typeof(models) = 'array'
),
separado AS (
  SELECT
    a.id,
    -- WITH ORDINALITY + ORDER BY: a ordem do catálogo é informação (o mais novo
    -- primeiro). Reagrupar sem ordenar embaralharia a lista que a tela mostra.
    jsonb_agg(
      btrim(
        CASE
          WHEN position(E'\t' IN e.elem) > 0
            THEN substring(e.elem FROM position(E'\t' IN e.elem) + 1)
          ELSE e.elem
        END
      )
      ORDER BY e.ord
    ) AS limpo,
    bool_or(position(E'\t' IN e.elem) > 0) AS tinha_tab
  FROM alvo a
  CROSS JOIN LATERAL jsonb_array_elements_text(a.models) WITH ORDINALITY AS e(elem, ord)
  GROUP BY a.id
)
UPDATE engine_connections ec
SET models = s.limpo
FROM separado s
-- `tinha_tab` é o que torna a migração idempotente: linha já limpa não é
-- reescrita, então rodar de novo não muda nada nem gera escrita à toa.
WHERE ec.id = s.id
  AND s.tinha_tab;

COMMIT;
