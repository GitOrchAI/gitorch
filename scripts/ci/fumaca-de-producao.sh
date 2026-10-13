#!/usr/bin/env bash
#
# Fumaça em modo produção: sobe o control-plane compilado exatamente como a
# produção o sobe (NODE_ENV=production, sem nenhuma flag de motor ou de acesso
# fake) e confere que ele de fato fica de pé e serve o front recém-construído.
#
# Confere, nesta ordem:
#   1. /health e /ready respondem 200 em até 60 s;
#   2. GET /setup devolve byte a byte o front construído (md5 igual ao de
#      apps/web/out/setup/index.html);
#   3. GET /api/v1/version responde 200 com commit e noArDesde;
#   4. o log do processo não tem nenhuma linha de nível erro (pino, nível >= 50).
# O processo é derrubado por trap, qualquer que seja o resultado.
#
# Uso:  scripts/ci/fumaca-de-producao.sh   (da raiz do repositório, depois do
#       build do web e do control-plane, com o banco já migrado)
#
# Variáveis opcionais, para provar um PACOTE aberto em outra pasta em vez do
# checkout construído:
#   FUMACA_RAIZ              raiz com apps/control-plane/dist e apps/web/out
#                            (padrão: a raiz do repositório git);
#   FUMACA_COMMIT_ESPERADO   se definida, /api/v1/version precisa devolver
#                            exatamente este commit.
#
# Variáveis que o serviço EXIGE para subir em produção (vêm do job):
#   DATABASE_URL            banco já migrado (use montar-banco-como-a-main.sh)
#   REDIS_URL               redis alcançável
#   JWT_SECRET              mínimo 32 caracteres
#   GITHUB_WEBHOOK_SECRET   qualquer texto não vazio (o serviço recusa subir sem)
#   GITORCH_CREDENTIAL_KEY  32 bytes em hex (64 caracteres) ou base64
# O script fixa por conta própria o que a produção também fixa:
#   NODE_ENV=production, HOST=127.0.0.1, PORT=$FUMACA_PORT (padrão 4013),
#   GITORCH_TRUST_PROXY=1 e GITORCH_RATE_LIMIT_ALLOWLIST vazio (sem isso o
#   serviço registra erro de configuração de rate limit em produção),
#   FRONTEND_URL e CORS_ORIGIN apontando para a própria porta.
# Diretórios de trabalho (GITORCH_WORKSPACES_DIR, GITORCH_CORTEX_DB,
# GITORCH_ENVIRONMENTS_DIR) caem em um diretório temporário se não definidos.
# GITORCH_FAKE_ENGINES e GITORCH_FAKE_GITHUB_ACCESS são removidos do ambiente
# do processo: a produção recusa essas flags e a fumaça prova o modo real.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL ausente}"
: "${REDIS_URL:?REDIS_URL ausente}"
: "${JWT_SECRET:?JWT_SECRET ausente}"
: "${GITHUB_WEBHOOK_SECRET:?GITHUB_WEBHOOK_SECRET ausente}"
: "${GITORCH_CREDENTIAL_KEY:?GITORCH_CREDENTIAL_KEY ausente}"

RAIZ="${FUMACA_RAIZ:-$(git rev-parse --show-toplevel)}"
PORTA="${FUMACA_PORT:-4013}"
BASE="http://127.0.0.1:${PORTA}"
FRONT="$RAIZ/apps/web/out/setup/index.html"

[ -f "$RAIZ/apps/control-plane/dist/index.js" ] || {
  echo "[fumaca] apps/control-plane/dist/index.js ausente: rode o build do control-plane antes" >&2
  exit 1
}
[ -f "$FRONT" ] || {
  echo "[fumaca] $FRONT ausente: rode o build do web antes" >&2
  exit 1
}

TMP="$(mktemp -d -t gitorch-fumaca-XXXXXX)"
LOG="$TMP/control-plane.log"
PID=""
limpar() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap limpar EXIT

falhar() {
  echo "[fumaca] FALHA: $1" >&2
  echo "[fumaca] últimas linhas do log do serviço:" >&2
  tail -n 40 "$LOG" >&2 || true
  exit 1
}

cd "$RAIZ/apps/control-plane"
env -u GITORCH_FAKE_ENGINES -u GITORCH_FAKE_GITHUB_ACCESS \
  NODE_ENV=production \
  HOST=127.0.0.1 \
  PORT="$PORTA" \
  FRONTEND_URL="$BASE" \
  CORS_ORIGIN="$BASE" \
  GITORCH_TRUST_PROXY=1 \
  GITORCH_RATE_LIMIT_ALLOWLIST= \
  GITORCH_WORKSPACES_DIR="${GITORCH_WORKSPACES_DIR:-$TMP/workspaces}" \
  GITORCH_CORTEX_DB="${GITORCH_CORTEX_DB:-$TMP/cortex.sqlite}" \
  GITORCH_ENVIRONMENTS_DIR="${GITORCH_ENVIRONMENTS_DIR:-$TMP/environments}" \
  node dist/index.js >"$LOG" 2>&1 &
PID=$!
echo "[fumaca] serviço em modo produção na porta $PORTA (pid $PID)"

espera_200() { # caminho
  local i
  for i in $(seq 1 60); do
    kill -0 "$PID" 2>/dev/null || falhar "o processo morreu antes de responder $1"
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$1" || true)" = "200" ]; then
      echo "[fumaca] $1 respondeu 200 (${i}s)"
      return 0
    fi
    sleep 1
  done
  falhar "$1 não respondeu 200 em 60 s"
}
espera_200 /health
espera_200 /ready

SERVIDO="$(curl -s "$BASE/setup" | md5sum | cut -d' ' -f1)"
CONSTRUIDO="$(md5sum "$FRONT" | cut -d' ' -f1)"
[ "$SERVIDO" = "$CONSTRUIDO" ] || falhar "GET /setup (md5 $SERVIDO) não é o front recém-construído (md5 $CONSTRUIDO)"
echo "[fumaca] /setup é o front recém-construído (md5 $CONSTRUIDO)"

VERSAO="$(curl -s -w '\n%{http_code}' "$BASE/api/v1/version")"
[ "${VERSAO##*$'\n'}" = "200" ] || falhar "GET /api/v1/version não respondeu 200"
echo "${VERSAO%$'\n'*}" | node -e '
  const v = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (typeof v.commit !== "string" || typeof v.noArDesde !== "string") process.exit(1);
' || falhar "/api/v1/version sem commit e noArDesde"
if [ -n "${FUMACA_COMMIT_ESPERADO:-}" ]; then
  echo "${VERSAO%$'\n'*}" | ESPERADO="$FUMACA_COMMIT_ESPERADO" node -e '
    const v = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (v.commit !== process.env.ESPERADO) process.exit(1);
  ' || falhar "/api/v1/version não devolveu o commit esperado ($FUMACA_COMMIT_ESPERADO)"
fi
echo "[fumaca] /api/v1/version ok: ${VERSAO%$'\n'*}"

# O log é JSON (pino); nível >= 50 é erro ou fatal. Linha que não é JSON é ignorada.
ERROS="$(node -e '
  const linhas = require("fs").readFileSync(process.argv[1], "utf8").split("\n");
  for (const l of linhas) {
    if (!l.startsWith("{")) continue;
    try { const o = JSON.parse(l); if (typeof o.level === "number" && o.level >= 50) console.log(l); } catch {}
  }
' "$LOG")"
if [ -n "$ERROS" ]; then
  echo "[fumaca] FALHA: o log do serviço tem linha de nível erro:" >&2
  echo "$ERROS" >&2
  exit 1
fi
echo "[fumaca] log sem nenhuma linha de nível erro"
echo "[fumaca] fumaça de produção ok"
