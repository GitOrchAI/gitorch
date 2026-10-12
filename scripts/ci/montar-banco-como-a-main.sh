#!/usr/bin/env bash
#
# Monta o banco do staging do PR do jeito que a produção chega nele: primeiro
# as migrações COMO A BASE (a main) as aplica, depois as migrações do checkout
# atual por cima. Um banco montado do zero a partir do schema atual (`db push`)
# nunca pega migração que só funciona em banco vazio, nem a que quebra sobre os
# dados e tabelas que a base já criou; este caminho pega.
#
# Uso:    DATABASE_URL=postgresql://... scripts/ci/montar-banco-como-a-main.sh <ref-da-base>
#         <ref-da-base> é qualquer ref que o git resolva (origin/main, um sha).
#
# Exige:  DATABASE_URL de um banco VAZIO (o script recusa banco com tabelas),
#         psql, git, pnpm e as dependências já instaladas no checkout atual.
#
# Como: o checkout da base vira um worktree temporário destacado (removido por
# trap), com as próprias dependências instaladas e o client do Prisma gerado do
# schema DELA (um link para o node_modules atual faria o seed da base falar com
# um client gerado do schema novo). Em cada checkout roda o mesmo
# apps/control-plane/scripts/db-migrate.sh que a produção usa. Se a base é o
# próprio commit atual (push na main), o passo da base roda no checkout atual.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL ausente}"
BASE_REF="${1:?uso: montar-banco-como-a-main.sh <ref-da-base>}"

RAIZ="$(git rev-parse --show-toplevel)"
cd "$RAIZ"

SHA_BASE="$(git rev-parse --verify --quiet "${BASE_REF}^{commit}")" || {
  echo "[montar-banco] a ref da base '$BASE_REF' não existe neste repositório (falta buscar o histórico?)" >&2
  exit 1
}
SHA_ATUAL="$(git rev-parse HEAD)"

TABELAS="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtA -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")"
if [ "$TABELAS" != "0" ]; then
  echo "[montar-banco] o banco não está vazio ($TABELAS tabelas em public); este script só monta banco descartável a partir do zero" >&2
  exit 1
fi

TMP_BASE=""
limpar() {
  if [ -n "$TMP_BASE" ] && [ -d "$TMP_BASE" ]; then
    git -C "$RAIZ" worktree remove --force "$TMP_BASE" >/dev/null 2>&1 || rm -rf "$TMP_BASE"
    git -C "$RAIZ" worktree prune
  fi
}
trap limpar EXIT

if [ "$SHA_BASE" = "$SHA_ATUAL" ]; then
  echo "[montar-banco] a base ($SHA_BASE) é o commit atual: passo da base roda no checkout atual"
  DIR_BASE="$RAIZ"
else
  TMP_BASE="$(mktemp -d -t gitorch-base-XXXXXX)"
  echo "[montar-banco] checkout temporário da base $SHA_BASE"
  git worktree add --detach "$TMP_BASE" "$SHA_BASE" >/dev/null
  DIR_BASE="$TMP_BASE"
  echo "[montar-banco] instalando dependências da base"
  (cd "$DIR_BASE" && CI=1 pnpm install --frozen-lockfile --prefer-offline >/dev/null)
  (cd "$DIR_BASE/apps/control-plane" && pnpm exec prisma generate >/dev/null)
fi

echo "[montar-banco] 1/2 migrações como a base as aplica ($SHA_BASE)"
bash "$DIR_BASE/apps/control-plane/scripts/db-migrate.sh" || {
  echo "[montar-banco] FALHA: as migrações da BASE não aplicaram em banco vazio (problema anterior a este PR)" >&2
  exit 1
}

echo "[montar-banco] 2/2 migrações do checkout atual por cima ($SHA_ATUAL)"
bash "$RAIZ/apps/control-plane/scripts/db-migrate.sh" || {
  echo "[montar-banco] FALHA: as migrações deste PR não aplicam sobre um banco no estado da base (veja acima qual migração)" >&2
  exit 1
}

echo "[montar-banco] banco pronto: estado da base mais as migrações do checkout atual"
