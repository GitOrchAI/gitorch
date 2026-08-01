#!/usr/bin/env bash
#
# Runner do ledger de migração (E14/OV#1). Idempotente; seguro pra rodar em
# todo deploy ANTES do switch de tráfego (F2.3.2 chama isto). Exige: psql no
# PATH, DATABASE_URL no ambiente.
#
# Dois casos pra estabelecer o schema base, decididos pelo estado real do
# banco (nunca por uma flag):
#  - banco VIRGEM (sem tabela `users`): baseline completo via `prisma migrate
#    diff --from-empty` (só CREATE, gerado do schema.prisma atual).
#  - banco não-virgem (`users` já existe — legado A1/dev ou já migrado
#    antes): pula o baseline, o schema já está lá.
#
# A partir daí o caminho é ÚNICO pros dois casos (ver achado de review
# F2.1.6#1): o seed dos planos roda SEMPRE, incondicional, e só depois o
# ledger é reconciliado — aplica em ordem só o que ainda não está em
# gitorch_schema_migrations (pra banco virgem isso é "todos os 12"; pra banco
# legado, só o que faltar). Rodar seed incondicionalmente é deliberado: seed é
# idempotente (só upsert, ver prisma/seed.ts) e a alternativa — rastrear "seed
# aplicado" como uma linha sintética no ledger — quebraria o drift-guard 1:1
# que compara MIGRATION_LEDGER contra os arquivos *-migration.sql em disco
# (migration-ledger.test.ts), por uma entrada que não corresponde a nenhum
# arquivo real. Antes desta correção, o seed só rodava dentro do branch
# virgem: uma morte do processo depois do baseline criar `users` mas antes do
# seed terminar fazia toda rodada futura ver `users` existindo, tomar o branch
# não-virgem, e NUNCA rodar o seed de novo — a tabela `plans` ficava vazia
# pra sempre enquanto o script saía com exit 0 dizendo "em dia". Como
# User.planId tem FK obrigatória pra Plan.id, o primeiro signup real quebrava
# com violação de FK. Seed incondicional fecha esse buraco: não existe mais
# um estado intermediário onde `users` existe e os planos não.
#
# Recuperação de falha: cada migração só é registrada em
# gitorch_schema_migrations DEPOIS de aplicada com sucesso (ON_ERROR_STOP=1 +
# set -e abortam no primeiro erro, ANTES do registro). Uma falha no meio do
# caminho não deixa meio-estado: a migração que falhou não fica marcada como
# aplicada, e como todo SQL do ledger é idempotente, rodar o script de novo
# reaplica exatamente a partir dela (as anteriores, já registradas, são
# puladas). O script não decide "resumir" — o estado do banco decide.
#
# Drift de conteúdo: o checksum sha256 gravado por migração é COMPARADO (não
# só guardado) a cada rodada contra o arquivo atual em prisma/ — se o
# conteúdo de uma migração já aplicada mudou desde então, o script aborta em
# vez de pular silenciosamente (achado de review F2.1.6#5).
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
fi

# Seed roda sempre — virgem ou não, ver cabeçalho do arquivo. Precisa vir
# depois do baseline (senão a tabela `plans` não existe ainda no caso virgem)
# e antes do ledger (não depende dele; planos não são criados por nenhum dos
# 12 SQLs).
echo "[db-migrate] seed de planos (idempotente, roda sempre)"
"$TSX_BIN" prisma/seed.ts

declare -A LEDGER_SET=()
for m in "${LEDGER[@]}"; do LEDGER_SET["$m"]=1; done

# Captura direta (não process substitution): `mapfile -t X < <(cmd)` roda cmd
# num subshell cujo exit code o `set -e` do shell pai NÃO enxerga — uma falha
# de psql aqui (timeout de lock, permissão, conectividade) silenciosamente
# vira APPLIED_RAW vazio, indistinguível de "banco sem nada aplicado ainda",
# e o script reaplicaria e re-registraria tudo de novo, mascarando o erro real
# (achado de review F2.1.6#3). `VAR=$(cmd)` é uma atribuição simples: seu
# exit code É o do comando, e o `set -e` aborta nela normalmente.
APPLIED_RAW=$("${PSQL[@]}" -c "SELECT name || '|' || checksum FROM gitorch_schema_migrations ORDER BY name")
mapfile -t APPLIED_ROWS <<< "$APPLIED_RAW"

APPLIED=()
for row in "${APPLIED_ROWS[@]:-}"; do
  [ -n "$row" ] || continue
  name="${row%%|*}"
  checksum="${row#*|}"
  if [ -z "${LEDGER_SET[$name]:-}" ]; then
    echo "[db-migrate] '$name' aplicada mas fora do ledger — banco à frente do código; ABORTA" >&2
    exit 2
  fi
  current_sum=$(sha256sum "prisma/$name" | cut -d' ' -f1)
  if [ "$current_sum" != "$checksum" ]; then
    echo "[db-migrate] DRIFT: '$name' foi aplicada, mas o conteúdo do arquivo mudou desde então (checksum não bate) — ABORTA" >&2
    exit 3
  fi
  APPLIED+=("$name")
done

is_applied() {
  local n
  for n in "${APPLIED[@]:-}"; do [ "$n" = "$1" ] && return 0; done
  return 1
}
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
