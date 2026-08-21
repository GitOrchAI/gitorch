-- O plano do dev assíncrono, declarado pelo dono no cadastro.
-- Aditivo: coluna nula, projetos existentes seguem no padrão gratuito.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS dev_plan TEXT;
