-- A ligacao entre a issue, a sessao do dev assincrono e o PR que ela produz.
--
-- Antes disto a ligacao existia SO no texto de saida da missao ("#24 ->
-- sessions/...") e evaporava com o log. Consequencia medida: o PR do dev sai
-- com o autor da conta da instalacao e sem palavra de ligacao no corpo, entao
-- nenhum sinal lido do GitHub sozinho o reconhece — e o julgamento nunca
-- acontecia, com o PR aberto na frente.
--
-- Guardamos o NUMERO do PR, nunca a URL: a URL vem de servico externo e
-- desreferencia-la seria transformar dado de fora em destino de chamada nossa.
CREATE TABLE IF NOT EXISTS dev_sessions (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  issue_number        INTEGER NOT NULL,
  session_name        TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'QUEUED',
  state_checked_at    TIMESTAMP(3),
  last_progress_at    TIMESTAMP(3),
  answered_hash       TEXT,
  pull_request_number INTEGER,
  attempts            INTEGER NOT NULL DEFAULT 1,
  nudges              INTEGER NOT NULL DEFAULT 0,
  closed_at           TIMESTAMP(3),
  closed_reason       TEXT,
  created_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS dev_sessions_session_name_key
  ON dev_sessions (session_name);

-- Uma sessao VIVA por issue. Parcial de proposito: sessoes fechadas podem
-- repetir a mesma issue, porque re-delegar cria uma sessao nova e o historico
-- de tentativas tem de sobreviver.
CREATE UNIQUE INDEX IF NOT EXISTS dev_sessions_open_per_issue
  ON dev_sessions (project_id, issue_number) WHERE closed_at IS NULL;

-- A vigia so consulta sessao viva; este indice e o que a mantem barata.
CREATE INDEX IF NOT EXISTS dev_sessions_open_idx
  ON dev_sessions (closed_at) WHERE closed_at IS NULL;
