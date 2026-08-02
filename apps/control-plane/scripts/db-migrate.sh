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
# A partir daí o caminho é ÚNICO pros dois casos: primeiro o ledger é
# reconciliado — aplica em ordem só o que ainda não está em
# gitorch_schema_migrations (pra banco virgem isso é "todos os 12"; pra banco
# legado, só o que faltar) —, e SÓ DEPOIS roda o seed dos planos, em modo
# --plans-only (achado de review C1). ORDEM IMPORTA, e a versão anterior
# desta task tinha invertida: o seed grava tierRank/maxConcurrentMissions/
# seats/features em `plans` — colunas que só existem depois de
# billing-migration.sql, a PRIMEIRA entrada do ledger. Rodar o seed ANTES do
# ledger (como este script fazia até esta correção) deadlocka QUALQUER banco
# legado sem billing-migration aplicada (exatamente o caso "A1/dev legado"
# que o comentário acima diz suportar): o seed morre com "column tier_rank of
# relation plans does not exist", `set -e` aborta o script, o ledger NUNCA
# chega a rodar, billing-migration nunca é aplicada, e toda rodada futura
# repete o mesmíssimo erro — preso pra sempre, só destrancável à mão. Também
# armava a produção: a PRIMEIRA migração futura que alterasse `plans`/`users`
# quebraria o PRÓXIMO deploy, porque o seed sempre rodava contra o schema
# ANTERIOR com um client Prisma gerado do schema NOVO. Com o ledger primeiro,
# o schema já está atualizado quando o seed roda, nos dois caminhos (virgem e
# legado) — ver db-migrate.integration.test.ts pro banco-não-virgem-e-
# desatualizado que prova isso.
#
# Seed em modo --plans-only (não o seed completo) também é deliberado (achado
# I5): o bloco completo do seed (dono da instância + reivindicação de
# projetos legados sem dono, ensureDefaultSchedules) é uma migração de dados
# de 2025, não algo seguro de repetir em TODO deploy de um sistema
# multi-tenant — reescreveria dados de cliente (Project.userId nulo é só pra
# registro legado; ver prisma/schema.prisma) se algum dia um projeto acabar
# com userId nulo por outro motivo. Fica reservado pra invocação manual e
# explícita (`node_modules/.bin/tsx prisma/seed.ts`, sem a flag) — nunca
# automático.
#
# Rodar o seed --plans-only incondicionalmente a cada deploy é deliberado: é
# idempotente (só upsert dos 4 planos, ver prisma/seed.ts) e a alternativa —
# rastrear "seed aplicado" como uma linha sintética no ledger — quebraria o
# drift-guard 1:1 que compara MIGRATION_LEDGER contra os arquivos
# *-migration.sql em disco (migration-ledger.test.ts), por uma entrada que
# não corresponde a nenhum arquivo real. Rodar incondicionalmente também
# fecha o buraco original (F2.1.6#1): uma morte do processo entre o baseline
# e o seed não deixa `plans` vazia pra sempre — a rodada seguinte reaplica o
# ledger (idempotente, no-op se já tudo aplicado) e roda o seed de novo.
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

# Preflight (achado M4): prisma e tsx são devDependencies — um
# `pnpm install --prod` (ou um prune) no ambiente de deploy os apaga, e sem
# este check a primeira falha do script seria um "No such file or directory"
# cru vindo de dentro do `${PSQL[@]}`/binário chamado, sem pista nenhuma de
# causa. Falha aqui, ANTES de tocar o banco, com uma mensagem acionável.
for bin_path in "$PRISMA_BIN" "$TSX_BIN"; do
  [ -x "$bin_path" ] || {
    echo "[db-migrate] binário ausente ou não-executável: $bin_path — rode 'pnpm install' completo (sem --prod / sem prune de devDependencies) antes do deploy" >&2
    exit 1
  }
done

"${PSQL[@]}" -c "CREATE TABLE IF NOT EXISTS gitorch_schema_migrations (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())"

# Ordem canônica: extraída do MESMO módulo que o vitest valida (fonte única —
# ver src/lib/migration-ledger.ts). Nunca duplicar a lista aqui à mão.
mapfile -t LEDGER < <(grep -oE "'[a-z-]+-migration\.sql'" src/lib/migration-ledger.ts | tr -d "'")
# Guard de drift do PRÓPRIO extrator (achado I4, comparação exata desde o
# achado FW-6): a regex acima não casa dígito nem maiúscula. Um arquivo
# futuro tipo `2026-08-x-migration.sql` ficaria em disco E em
# MIGRATION_LEDGER (o array TS, fonte da verdade), mas sumiria desta
# extração — o guard hardcoded original (`-ge 12`) não pegava isso, porque a
# contagem extraída continuava >= 12 mesmo faltando um.
#
# Comparar só a CONTAGEM (achado FW-6) tem o mesmo buraco um nível acima: um
# comentário futuro citando '...-migration.sql' entre aspas simples (soma 1
# fantasma no LEDGER extraído, sem arquivo correspondente em disco) AO MESMO
# TEMPO que um arquivo real com dígito/maiúscula escapa da regex (soma 1 no
# disco, falta 1 no LEDGER extraído) — as duas contagens voltam a bater, e o
# guard passa batido com a lista de nomes divergente por baixo. Comparar as
# duas LISTAS de nomes, ordenadas, pega esse caso exato: só passa se forem
# EXATAMENTE os mesmos nomes, não só o mesmo tamanho.
mapfile -t ON_DISK < <(find prisma -maxdepth 1 -name '*-migration.sql' -type f -printf '%f\n' | sort)
SORTED_LEDGER=$(printf '%s\n' "${LEDGER[@]}" | sort)
[ "$SORTED_LEDGER" = "$(printf '%s\n' "${ON_DISK[@]}")" ] || {
  echo "[db-migrate] ledger extraído de src/lib/migration-ledger.ts (${#LEDGER[@]} entradas) != arquivos *-migration.sql em prisma/ (${#ON_DISK[@]}) — regex de extração dessincronizada (nome com dígito/maiúscula? comentário citando um nome fantasma?)" >&2
  echo "[db-migrate] extraído: $(printf '%s ' "${LEDGER[@]}")" >&2
  echo "[db-migrate] em disco: $(printf '%s ' "${ON_DISK[@]}")" >&2
  exit 1
}

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
echo "[db-migrate] ledger em dia ($PEND aplicadas agora, $(( ${#LEDGER[@]} - PEND )) já registradas)"

# Seed (--plans-only) roda por ÚLTIMO, depois do ledger inteiro reconciliado
# — ver cabeçalho do arquivo (achado C1). As colunas que ele grava só existem
# depois de billing-migration.sql (a 1ª entrada do ledger, já garantida
# acima nos dois caminhos, virgem ou legado).
echo "[db-migrate] seed de planos (--plans-only, idempotente, roda sempre)"
"$TSX_BIN" prisma/seed.ts --plans-only
