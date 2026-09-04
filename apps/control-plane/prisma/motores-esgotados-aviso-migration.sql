-- L4-T22 (fix-up, item 4): dedup DURÁVEL do aviso EXECUTIVO de "a cadeia
-- inteira de motores ficou sem cota" — ADITIVA e não-destrutiva.
--
-- POR QUÊ: a versão original desta tarefa deduplicava esse aviso num Map em
-- memória do processo (avisosDeMotoresEsgotados, scheduler.ts), MESMA
-- disciplina de avisosDeCredencialExpirada. Isso funciona por 24h só se o
-- processo continuar vivo — e o control-plane reinicia a CADA deploy. Sem
-- coluna nenhuma, um cliente cuja cadeia esgota cota perto de todo deploy
-- levaria o MESMO recado de novo a cada subida, spam que apaga sinal tanto
-- quanto o silêncio que a tarefa original veio consertar.
--
-- `motores_esgotados_avisado_em` guarda quando o último aviso saiu para este
-- projeto — sobrevive a restart, mesma disciplina de `deploy_notice_asked_key`
-- (aviso-de-publicacao-migration.sql).
--
-- COMO APLICAR: a partir de apps/control-plane, com DATABASE_URL no ambiente:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/motores-esgotados-aviso-migration.sql
-- (ou via apps/control-plane/scripts/db-migrate.sh, que reconcilia o ledger inteiro)

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "motores_esgotados_avisado_em" TIMESTAMP(3);
