-- Até onde o GitOrch pode ir no repositório do cliente, por projeto.
--
-- Antes disto a decisão não existia como dado: estava espalhada em código, e o
-- produto escrevia no repositório de quem nunca disse que podia. Decisão do
-- dono (29/08): quem pluga escolhe entre SÓ OLHAR, SUGERIR e CUIDAR, e a
-- premissa é pedir permissão A MAIS.
--
-- DUAS COISAS DIFERENTES, e confundir as duas quebra alguma coisa:
--
--   O PADRÃO DA COLUNA é 'so_olhar' — vale para quem PLUGAR DAQUI PARA FRENTE.
--   É a premissa do dono: quem acaba de chegar não autorizou nada ainda.
--
--   AS LINHAS QUE JÁ EXISTEM sobem como 'cuidar', porque é o que elas JÁ FAZEM
--   hoje, com o dono sabendo: a esteira abre issue, delega e mescla nesses
--   repositórios agora mesmo. Uma migração aditiva não pode mudar o
--   comportamento do que já está rodando — descer todo mundo para 'so_olhar'
--   pararia a esteira em produção em silêncio, e o dono descobriria pelo
--   trabalho que não aconteceu.
--
-- Quem discordar de um projeto antigo estar em 'cuidar' muda pelo painel; o
-- caminho existe. O que não pode é a migração decidir por ele nos dois
-- sentidos ao mesmo tempo.
--
-- É TEXT com CHECK, e não enum do Postgres: acrescentar um nível novo num enum
-- exige ALTER TYPE fora de transação, e mudar a política é coisa que vai
-- acontecer. O CHECK dá a mesma garantia e sai barato.
-- COMO as duas coisas convivem sem um UPDATE que possa errar o alvo:
--
--   O ADD COLUMN entra com DEFAULT 'cuidar', e o Postgres preenche as linhas
--   QUE JÁ EXISTEM com esse valor. Só elas — é o efeito do próprio ADD COLUMN.
--   Depois o DEFAULT vira 'so_olhar', e a partir daí toda linha nova nasce
--   restrita.
--
--   Foi assim, e não com `UPDATE ... WHERE`, porque um UPDATE aqui casaria
--   também com projetos criados DEPOIS desta migração, caso o arquivo rodasse
--   de novo — promoveria a 'cuidar' exatamente quem tinha acabado de chegar
--   sem autorizar nada. Deste jeito, rodar duas vezes não faz nada: o
--   ADD COLUMN é pulado pelo IF NOT EXISTS e o SET DEFAULT já está no valor
--   final.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS autonomia TEXT NOT NULL DEFAULT 'cuidar';
ALTER TABLE projects ALTER COLUMN autonomia SET DEFAULT 'so_olhar';

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_autonomia_check;
ALTER TABLE projects ADD CONSTRAINT projects_autonomia_check
  CHECK (autonomia IN ('so_olhar', 'sugerir', 'cuidar'));

-- Quando o dono mexeu no nível pela última vez. Nulo = nunca escolheu, está no
-- padrão. O painel precisa dessa diferença para não dizer "você escolheu só
-- olhar" a quem nunca escolheu nada.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS autonomia_escolhida_em TIMESTAMP(3);
