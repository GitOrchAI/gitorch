#!/usr/bin/env bash
#
# Runner do ledger de migração (E14/OV#1). Idempotente; seguro pra rodar em
# todo deploy ANTES do switch de tráfego (F2.3.2 chama isto). Exige: psql no
# PATH, DATABASE_URL no ambiente.
#
# Três casos, decididos pelo estado real do banco (nunca por uma flag):
#  - banco VIRGEM (sem tabela `users`): baseline completo via `prisma migrate
#    diff --from-empty` (só CREATE, gerado do schema.prisma atual) + seed dos
#    planos + replay idempotente dos 12 SQLs do ledger (paridade de registro
#    com o caminho legado) + ledger marcado como aplicado.
#  - banco LEGADO (`users` existe, gitorch_schema_migrations vazia — A1/dev,
#    aplicado à mão historicamente): re-aplica TODOS os SQLs em ordem — são
#    idempotentes (IF NOT EXISTS / DROP...IF EXISTS+ADD) — e registra cada um.
#  - banco EM DIA: aplica só as pendentes, em ordem, registrando cada uma.
#
# Recuperação de falha: cada migração só é registrada em
# gitorch_schema_migrations DEPOIS de aplicada com sucesso (ON_ERROR_STOP=1 +
# set -e abortam no primeiro erro, ANTES do registro). Uma falha no meio do
# caminho não deixa meio-estado: a migração que falhou não fica marcada como
# aplicada, e como todo SQL do ledger é idempotente, rodar o script de novo
# reaplica exatamente a partir dela (as anteriores, já registradas, são
# puladas). O script não decide "resumir" — o estado do banco decide.
set -euo pipefail
cd "$(dirname "$0")/.."   # apps/control-plane
: "${DATABASE_URL:?DATABASE_URL ausente}"
PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtA)
# Binários locais em vez de `npx`: mesmo diretório em todo ambiente (CI e VM
# de deploy) e imune a um `npx` global quebrado/desatualizado no PATH da
# máquina (achado real ao vivo nesta task — não é hipotético).
PRISMA_BIN="node_modules/.bin/prisma"
TSX_BIN="node_modules/.bin/tsx"

"${PSQL[@]}" -c "CREATE TABLE IF NOT EXISTS gitorch_schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())"

# Ordem canônica: extraída do MESMO módulo que o vitest valida (fonte única —
# ver src/lib/migration-ledger.ts). Nunca duplicar a lista aqui à mão.
mapfile -t LEDGER < <(grep -oE "'[a-z-]+-migration\.sql'" src/lib/migration-ledger.ts | tr -d "'")
[ "${#LEDGER[@]}" -ge 12 ] || { echo "[db-migrate] ledger vazio/curto — módulo movido ou formato mudou?" >&2; exit 1; }

registra() { # nome
  local sum
  sum=$(sha256sum "prisma/$1" | cut -d' ' -f1)
  "${PSQL[@]}" -c "INSERT INTO gitorch_schema_migrations(name, checksum) VALUES ('$1','$sum')
                   ON CONFLICT (name) DO NOTHING"
}

USERS_EXISTS=$("${PSQL[@]}" -c "SELECT to_regclass('public.users') IS NOT NULL")
if [ "$USERS_EXISTS" != "t" ]; then
  echo "[db-migrate] banco VIRGEM: baseline do schema.prisma"
  TMP_BASELINE="$(mktemp -t gitorch-baseline-XXXXXX.sql)"
  trap 'rm -f "$TMP_BASELINE"' EXIT
  "$PRISMA_BIN" migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > "$TMP_BASELINE"
  "${PSQL[@]}" -f "$TMP_BASELINE"
  rm -f "$TMP_BASELINE"
  trap - EXIT
  echo "[db-migrate] seed de planos (mesmo passo do e2e-wizard.yml)"
  "$TSX_BIN" prisma/seed.ts
  for m in "${LEDGER[@]}"; do
    "${PSQL[@]}" -f "prisma/$m"   # idempotentes: baseline já cobre; replay garante paridade de registro
    registra "$m"
  done
  echo "[db-migrate] virgem -> baseline + ${#LEDGER[@]} entradas registradas"
  exit 0
fi

mapfile -t APPLIED < <("${PSQL[@]}" -c "SELECT name FROM gitorch_schema_migrations ORDER BY name")
is_applied() {
  local n
  for n in "${APPLIED[@]:-}"; do [ "$n" = "$1" ] && return 0; done
  return 1
}
for a in "${APPLIED[@]:-}"; do
  [ -n "$a" ] || continue
  ok=1
  for m in "${LEDGER[@]}"; do [ "$m" = "$a" ] && ok=0; done
  [ "$ok" = 0 ] || { echo "[db-migrate] '$a' aplicada mas fora do ledger — banco à frente do código; ABORTA" >&2; exit 2; }
done
PEND=0
for m in "${LEDGER[@]}"; do
  if ! is_applied "$m"; then
    echo "[db-migrate] aplicando $m"
    "${PSQL[@]}" -f "prisma/$m"
    registra "$m"
    PEND=$((PEND + 1))
  fi
done
echo "[db-migrate] em dia ($PEND aplicadas agora, $(( ${#LEDGER[@]} - PEND )) já registradas)"
