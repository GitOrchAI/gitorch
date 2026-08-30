-- A duração da sprint é escolha do CLIENTE, não constante nossa.
--
-- POR QUÊ: a duração vivia em `DIAS_DE_SPRINT_PADRAO = 3`
-- (services/garantir-sprint.ts). Enquanto isso era papel, servia. A partir do
-- momento em que o produto CRIA o campo de iteração no quadro do cliente, o
-- número passa a valer no quadro dele — e aí não é mais nossa decisão.
--
-- Decisão do dono (30/08/2026), palavra dele: "nosso projeto de desenvolvimento
-- 3 dias mas pra clientes no painel eles decidem de quantos dias". São duas
-- coisas: o padrão do produto continua 3, e cada cliente escolhe o dele.
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado —
--   scripts/db-migrate.sh
--   psql "$DATABASE_URL" -f prisma/sprint-dias-migration.sql
--
-- ADITIVA. Nenhuma linha existente muda de comportamento: a coluna nasce NULA,
-- que o código lê como "use o padrão do produto" (3 dias).

BEGIN;

-- NULO = ninguém escolheu, vale DIAS_DE_SPRINT_PADRAO. Guardar 3 aqui como
-- cópia apagaria a diferença entre "ele escolheu 3" e "ninguém escolheu" — a
-- mesma distinção que a autonomia e a régua de pronto precisaram fazer, e pela
-- mesma razão: a tela não pode afirmar uma decisão que não houve.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sprint_dias INTEGER;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sprint_dias_escolhido_em TIMESTAMP(3);

-- O teto de 1 a 60 dias vive no banco, não só na rota. Uma duração de 0 dias
-- criaria um ciclo que nunca fecha, e uma de 3650 tornaria a sprint um nome
-- bonito para "sem prazo" — as duas quebram a promessa do quadro em vez de
-- configurá-lo. A guarda na porta da rota protege quem passa pela rota; esta
-- protege também quem escrever no banco por outro caminho.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_sprint_dias_check;
ALTER TABLE projects ADD CONSTRAINT projects_sprint_dias_check
  CHECK (sprint_dias IS NULL OR (sprint_dias >= 1 AND sprint_dias <= 60));

COMMIT;
