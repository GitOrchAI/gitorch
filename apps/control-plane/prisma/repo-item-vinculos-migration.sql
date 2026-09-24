-- Migração: Cria a tabela repo_item_vinculos para armazenar o grafo completo
-- de vínculos dos itens do repositório (issues e PRs).

CREATE TABLE IF NOT EXISTS repo_item_vinculos (
  id                   TEXT PRIMARY KEY,
  repo_item_id         TEXT NOT NULL UNIQUE REFERENCES repo_items(id) ON DELETE CASCADE,
  hierarquia           JSONB,
  milestone            JSONB,
  project_fields       JSONB,
  labels_and_assignees JSONB,
  prs_ligados          JSONB,
  sessoes_jules        JSONB,
  criado_em            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  atualizado_em        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE repo_item_vinculos ADD COLUMN qa_review JSONB;
ALTER TABLE repo_item_vinculos ADD COLUMN status_check_rollup JSONB;
