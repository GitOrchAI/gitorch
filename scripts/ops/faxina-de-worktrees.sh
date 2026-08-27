#!/usr/bin/env bash
#
# Apaga as pastas de trabalho (git worktrees) cujo trabalho JÁ ENTROU na main.
#
# POR QUE EXISTE: em 27/08/2026 o disco da máquina de trabalho chegou a 85% e
# disparou o alerta. A causa eram 58 pastas de trabalho acumuladas, cada uma
# com o próprio node_modules. Removidas as 55 já mescladas, o disco caiu para
# 33% — 72 GB numa tacada. O método do projeto já manda apagar a pasta depois
# do deploy verde; não havia nada que fizesse isso.
#
# DUAS ARMADILHAS QUE A LIMPEZA NA MÃO ENSINOU, e que este script respeita:
#
#   1. Trabalho não salvo NUNCA é tocado. Duas das 58 tinham alterações não
#      commitadas. Apagar isso é perda irreversível — nenhuma economia de disco
#      justifica.
#
#   2. `git merge-base --is-ancestor` NÃO detecta merge por squash. Como todo
#      merge deste projeto é squash, o commit do ramo nunca vira ancestral da
#      main, e o teste devolve "não mesclado" para tudo. O que funciona é
#      cruzar o NOME do ramo com a lista de PRs mesclados.
#
# Sem argumento roda em ENSAIO: mostra o que faria e não apaga nada. Só apaga
# com --apply, de propósito — um script que apaga por padrão é um acidente
# esperando data.
set -euo pipefail

# Nada de caminho de máquina escrito aqui: este repositório é PÚBLICO, e o
# portão de infra barra (com razão) qualquer path da nossa VM. O repositório
# sai do próprio git, e o disco medido é o de quem hospeda o repositório.
REPO="${GITORCH_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
APLICAR=0
[ "${1:-}" = "--apply" ] && APLICAR=1

cd "$REPO"

livre_antes=$(df -BM --output=avail "$REPO" | tail -1 | tr -dc '0-9')

# Os ramos cujo PR foi mesclado. Uma chamada só; se a rede falhar, o script
# não apaga nada — silêncio é melhor que apagar por engano.
mesclados=$(gh pr list --state merged --limit 300 --json headRefName -q '.[].headRefName' 2>/dev/null | sort -u)
if [ -z "$mesclados" ]; then
  echo "[faxina] não consegui a lista de PRs mesclados; não vou apagar nada"
  exit 0
fi

removidas=0
mantidas=0
while IFS='|' read -r pasta ramo; do
  [ -z "$pasta" ] && continue
  # Só as pastas de trabalho, nunca o checkout principal. O nome da pasta-mãe
  # é configurável para quem organizar diferente.
  case "$pasta" in *"/${GITORCH_WORKTREES_DIR:-gitorch-worktrees}/"*) ;; *) continue ;; esac

  if ! printf '%s\n' "$mesclados" | grep -qxF "$ramo"; then
    mantidas=$((mantidas + 1))
    continue
  fi

  # A guarda que não se negocia.
  if [ -n "$(git -C "$pasta" status --porcelain 2>/dev/null | head -1)" ]; then
    echo "[faxina] MANTIDA (tem trabalho não salvo): $(basename "$pasta")"
    mantidas=$((mantidas + 1))
    continue
  fi

  if [ "$APLICAR" = "1" ]; then
    git worktree remove --force "$pasta" 2>/dev/null && removidas=$((removidas + 1))
  else
    echo "[faxina] apagaria: $(basename "$pasta")  (ramo $ramo, PR mesclado)"
    removidas=$((removidas + 1))
  fi
done < <(git worktree list --porcelain | awk '/^worktree /{w=$2} /^branch /{print w"|"substr($2,12)}')

[ "$APLICAR" = "1" ] && git worktree prune 2>/dev/null || true

livre_depois=$(df -BM --output=avail "$REPO" | tail -1 | tr -dc '0-9')
ganho=$((livre_depois - livre_antes))

if [ "$APLICAR" = "1" ]; then
  echo "[faxina] removidas: $removidas | mantidas: $mantidas | liberado: ${ganho}MB"
  # Avisa o dono SÓ quando houve ganho de verdade. Aviso de rotina vira ruído,
  # e ruído apaga sinal tanto quanto silêncio.
  if [ "$ganho" -ge 1024 ] && [ -n "${GITORCH_TELEGRAM_BOT_TOKEN:-}${TELEGRAM_BOT_TOKEN:-}" ]; then
    token="${GITORCH_TELEGRAM_BOT_TOKEN:-$TELEGRAM_BOT_TOKEN}"
    chat="${GITORCH_TELEGRAM_CHAT_ID:-${TELEGRAM_CHAT_ID:-}}"
    [ -n "$chat" ] && curl -s -o /dev/null -m 15 \
      "https://api.telegram.org/bot${token}/sendMessage" \
      -d "chat_id=${chat}" \
      -d "text=GitOrch infra: a faxina liberou $((ganho / 1024)) GB (${removidas} pastas de trabalho já mescladas). Nada com trabalho não salvo foi tocado."
  fi
else
  echo "[faxina] ENSAIO: apagaria $removidas, manteria $mantidas. Rode com --apply para valer."
fi

# COMO AGENDAR (registrado aqui porque crontab não é versionado e este projeto
# já perdeu configuração por isso):
#
#   43 * * * * cd <raiz-do-repo> && \
#     bash scripts/ops/faxina-de-worktrees.sh --apply >> /tmp/faxina-worktrees.log 2>&1
#
# De hora em hora, no minuto 43 — deslocado do minuto em que o monitor de disco
# roda, para as duas coisas não brigarem pelo disco no mesmo instante.
