-- Até onde o GitOrch pode ir no repositório do cliente, por projeto.
--
-- POR QUÊ: antes disto a decisão não existia como dado — estava espalhada em
-- código, e o produto escrevia no repositório de quem nunca disse que podia.
-- Auditado ao vivo em 29/08/2026: ONZE chamadas dentro do relógio abriam,
-- comentavam e fechavam issue no repositório do cliente sem perguntar nada.
--
-- Decisão do dono (29/08): o cliente escolhe entre SÓ OLHAR, SUGERIR e CUIDAR,
-- e a premissa é pedir permissão A MAIS. A escolha é feita no assistente de
-- setup — plugar o repositório não é, sozinho, autorização para escrever nele.
--
-- COMO APLICAR: a partir de apps/control-plane, com o .env carregado —
--   scripts/db-migrate.sh
--   psql "$DATABASE_URL" -f prisma/autonomia-do-projeto-migration.sql
--
-- ---------------------------------------------------------------------------
-- DUAS COISAS DIFERENTES, e confundir as duas quebra alguma coisa:
--
--   O PADRÃO DA COLUNA é 'so_olhar' — vale para quem PLUGAR DAQUI PARA FRENTE.
--   Quem acaba de chegar não autorizou nada ainda.
--
--   AS LINHAS QUE JÁ EXISTEM sobem como 'cuidar', porque é o que elas JÁ FAZEM
--   hoje, com o dono sabendo: a esteira abre issue, delega e mescla nesses
--   repositórios agora mesmo. Uma migração aditiva não pode mudar o
--   comportamento do que já está rodando — descer todo mundo para 'so_olhar'
--   pararia a esteira em produção em silêncio, e o dono descobriria pelo
--   trabalho que não aconteceu.
--
-- COMO as duas convivem sem um UPDATE que possa errar o alvo:
--   o ADD COLUMN entra com DEFAULT 'cuidar', e o Postgres preenche as linhas
--   QUE JÁ EXISTEM com esse valor — só elas, é efeito do próprio ADD COLUMN.
--   Depois o DEFAULT vira 'so_olhar', e a partir daí toda linha nova nasce
--   restrita.
--
--   Foi assim, e não com `UPDATE ... WHERE`, porque um UPDATE casaria também
--   com projeto criado DEPOIS desta migração, caso o arquivo rodasse de novo —
--   promoveria a 'cuidar' exatamente quem tinha acabado de chegar sem
--   autorizar nada.
--
-- EM UMA TRANSAÇÃO, e isto não é zelo: entre o ADD COLUMN e o SET DEFAULT o
-- padrão da coluna é 'cuidar'. Sem BEGIN/COMMIT, um INSERT em SQL cru que caia
-- nessa janela nasce com o nível MAIS PERMISSIVO — exatamente o contrário do
-- que esta migração existe para garantir. O runner (scripts/db-migrate.sh) não
-- passa --single-transaction, então o arquivo abre a sua.
--
-- SOBRE O CHECK: ele mora aqui, dentro de um arquivo já registrado no ledger,
-- e o ledger confere checksum. Ou seja: acrescentar um nível novo NÃO é editar
-- esta linha (isso aborta o deploy com erro de checksum) — é escrever uma
-- migração nova que troque o CHECK. Está dito aqui porque a versão anterior
-- deste comentário prometia que "mudar a política sai barato", e não sai; sai
-- barato em relação a um enum do Postgres, que exigiria ALTER TYPE fora de
-- transação, mas continua sendo uma migração.
-- ---------------------------------------------------------------------------

BEGIN;

-- 1) A coluna entra com 'cuidar', o que preenche APENAS as linhas existentes.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS autonomia TEXT NOT NULL DEFAULT 'cuidar';

-- 2) E o padrão passa a ser o restrito, valendo para toda linha nova.
ALTER TABLE projects ALTER COLUMN autonomia SET DEFAULT 'so_olhar';

-- Rodar duas vezes não faz nada: o ADD COLUMN é pulado pelo IF NOT EXISTS e o
-- SET DEFAULT já está no valor final.

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_autonomia_check;
ALTER TABLE projects ADD CONSTRAINT projects_autonomia_check
  CHECK (autonomia IN ('so_olhar', 'sugerir', 'cuidar'));

-- Quando o CLIENTE escolheu o nível, no assistente de setup ou no painel.
--
-- NULO significa "o cliente nunca escolheu" — e é verdade nos DOIS casos:
-- projeto novo que ficou no padrão, e projeto antigo que esta migração
-- promoveu a 'cuidar' para preservar o que ele já fazia. Em nenhum dos dois o
-- cliente decidiu coisa alguma.
--
-- A versão anterior deste comentário dizia que nulo significava "está no
-- padrão", o que era falso justamente para as linhas promovidas — a migração
-- se contradizia. Não é o caso de carimbar uma data aqui: carimbar afirmaria
-- que o cliente escolheu 'cuidar', e ele não escolheu; foi a migração que
-- decidiu por ele para não parar a esteira. O painel usa essa diferença para
-- PERGUNTAR a ele, em vez de afirmar que ele já respondeu.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS autonomia_escolhida_em TIMESTAMP(3);

COMMIT;
