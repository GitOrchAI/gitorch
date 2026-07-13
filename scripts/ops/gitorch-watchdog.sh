#!/usr/bin/env bash
# GitOrch Watchdog — roda a cada 15 min via systemd timer.
# Regras:
#  (a) missão em "running" há mais de 2h  -> alerta
#  (b) >3 reinicializações de serviço gitorch na última hora -> alerta
#  (c) heartbeat diário "estou vivo" -> a ausência dele é, por si, sinal de problema
# Alertas via Telegram: usa GITORCH_TELEGRAM_BOT_TOKEN + GITORCH_TELEGRAM_CHAT_ID
# (cai para os nomes sem prefixo por compatibilidade). Sempre registra no
# journal (stdout/stderr). Obs.: o destinatário precisa ter iniciado conversa
# com o bot uma vez, senão o Telegram recusa com "chat not found".

set -u

# Caminho do .env do control plane; sobrescrevível por ambiente na unit.
# Default: o .env na raiz do checkout (dois níveis acima deste script), seja
# qual for o host — sem caminho absoluto de máquina específica embutido.
ENV_FILE="${GITORCH_ENV_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.env}"
STATE_DIR="/var/lib/gitorch/logs"
HEARTBEAT_FILE="$STATE_DIR/watchdog-heartbeat"
mkdir -p "$STATE_DIR"

getenv() {
  # Remove só aspas que envolvem o valor inteiro (não as internas de senhas).
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# Prefere as variáveis com prefixo GITORCH_; os nomes sem prefixo são aceitos
# apenas como retrocompatibilidade.
TELEGRAM_BOT_TOKEN="$(getenv GITORCH_TELEGRAM_BOT_TOKEN)"
[ -z "$TELEGRAM_BOT_TOKEN" ] && TELEGRAM_BOT_TOKEN="$(getenv TELEGRAM_BOT_TOKEN)"
TELEGRAM_CHAT_ID="$(getenv GITORCH_TELEGRAM_CHAT_ID)"
[ -z "$TELEGRAM_CHAT_ID" ] && TELEGRAM_CHAT_ID="$(getenv TELEGRAM_CHAT_ID)"
DATABASE_URL="$(getenv DATABASE_URL)"

alert() {
  local msg="$1"
  echo "[watchdog] ALERT: $msg"
  if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
    curl -s -m 15 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=GitOrch watchdog: ${msg}" >/dev/null || true
  else
    echo "[watchdog] Telegram indisponivel (sem TELEGRAM_CHAT_ID); alerta apenas no journal"
  fi
}

PROBLEMS=0

# (a) Missões travadas em running > 2h
if [ -n "$DATABASE_URL" ]; then
  STUCK=$(psql "$DATABASE_URL" -tA -c \
    "SELECT count(*) FROM missions WHERE status='running' AND started_at < now() - interval '2 hours';" 2>/dev/null || echo "ERR")
  if [ "$STUCK" = "ERR" ]; then
    alert "não consegui consultar o banco de missões"
    PROBLEMS=1
  elif [ "${STUCK:-0}" -gt 0 ] 2>/dev/null; then
    alert "${STUCK} missão(ões) presas em running há mais de 2h"
    PROBLEMS=1
  fi

  # Falhas recentes (últimos 20 min) — visibilidade imediata de missão falhada
  RECENT_FAILED=$(psql "$DATABASE_URL" -tA -c \
    "SELECT count(*) FROM missions WHERE status='failed' AND completed_at > now() - interval '20 minutes';" 2>/dev/null || echo 0)
  if [ "${RECENT_FAILED:-0}" -gt 0 ] 2>/dev/null; then
    LAST_ERR=$(psql "$DATABASE_URL" -tA -c \
      "SELECT coalesce(left(error,200),'?') FROM missions WHERE status='failed' ORDER BY completed_at DESC LIMIT 1;" 2>/dev/null || echo "?")
    alert "${RECENT_FAILED} missão(ões) falharam nos últimos 20 min. Último erro: ${LAST_ERR}"
    PROBLEMS=1
  fi
fi

# (b) Reinicializações de serviços gitorch na última hora (>3 = problema)
for UNIT in gitorch-control-plane.service; do
  if ! systemctl is-active --quiet "$UNIT"; then
    alert "serviço ${UNIT} está inativo"
    PROBLEMS=1
    continue
  fi
  # Fonte confiável de restarts: NRestarts do próprio systemd (não depende de
  # permissão de leitura do journal, que silenciaria o alarme se faltasse).
  RESTARTS=$(systemctl show "$UNIT" -p NRestarts --value 2>/dev/null || echo "ERR")
  if [ "$RESTARTS" = "ERR" ] || [ -z "$RESTARTS" ]; then
    alert "não consegui ler NRestarts de ${UNIT}"
    PROBLEMS=1
  elif [ "$RESTARTS" -gt 3 ] 2>/dev/null; then
    alert "serviço ${UNIT} acumulou ${RESTARTS} reinicializações (NRestarts)"
    PROBLEMS=1
  fi
done

# (c) Heartbeat diário (por volta das 09:00 locais; janela do timer de 15 min)
HOUR=$(date +%H)
TODAY=$(date +%Y-%m-%d)
LAST_BEAT=$(cat "$HEARTBEAT_FILE" 2>/dev/null || echo "never")
if [ "$HOUR" = "09" ] && [ "$LAST_BEAT" != "$TODAY" ]; then
  COMPLETED_24H="?"
  FAILED_24H="?"
  if [ -n "$DATABASE_URL" ]; then
    COMPLETED_24H=$(psql "$DATABASE_URL" -tA -c "SELECT count(*) FROM missions WHERE status='completed' AND completed_at > now() - interval '24 hours';" 2>/dev/null || echo "?")
    FAILED_24H=$(psql "$DATABASE_URL" -tA -c "SELECT count(*) FROM missions WHERE status='failed' AND completed_at > now() - interval '24 hours';" 2>/dev/null || echo "?")
  fi
  alert "estou vivo. Últimas 24h: ${COMPLETED_24H} missões concluídas, ${FAILED_24H} falhas."
  echo "$TODAY" > "$HEARTBEAT_FILE"
fi

if [ "$PROBLEMS" -eq 0 ]; then
  echo "[watchdog] OK $(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
exit 0
