-- D16 (01/09/2026): a vez pendente de passagem de bastão entre papéis que
-- sobrevive a um restart do control-plane.
--
-- A fila de sempre (passagemDeBastao, um Set em memória de scheduler.ts)
-- continua sendo a fonte de verdade DENTRO da vida de um processo — esta
-- tabela é só o espelho durável: gravada no mesmo instante em que a fila em
-- memória enfileira, e apagada quando a vez é honrada (disparou, com sucesso
-- ou falha definitiva). Sem ela, um restart no meio de um handoff apagava a
-- fila inteira e o papel seguinte — com o trabalho já PRONTO e esperando —
-- só rodava no próximo horário de cron: medido em produção (RA 06h/18h, PO
-- 03h/15h), até 9 HORAS de espera. Em 30h de produção real: 6 missões
-- mortas como "Órfã de restart" porque a vez nunca sobreviveu ao processo
-- morrer.
--
-- `tentativas`: conta BOOTS que já retomaram esta vez, não recusas dentro de
-- um mesmo processo — o teto (TENTATIVAS_MAX_NO_BOOT em
-- src/services/vez-pendente.ts) existe para um papel genuinamente quebrado
-- nunca ser redisparado para sempre a cada subida.
--
-- Aditiva e idempotente: pode rodar em banco já povoado.
CREATE TABLE IF NOT EXISTS vez_pendente (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  agent_role  TEXT NOT NULL,
  tentativas  SMALLINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS vez_pendente_project_role_key
  ON vez_pendente (project_id, agent_role);
