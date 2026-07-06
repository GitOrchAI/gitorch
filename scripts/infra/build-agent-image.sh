#!/usr/bin/env bash
# Constrói a imagem de execução das missões (gitorch-agent).
# Uso: scripts/infra/build-agent-image.sh [tag]
# Env: GITORCH_AGY_BIN (caminho do binário agy no host; default: `command -v agy`)
#      GITORCH_CONTAINER_ENGINE (podman|docker; default: podman)
#      GITORCH_ALLOW_NO_AGY=1  permite buildar SEM o agy (nós que só usam os motores
#                              npm portáveis, ex.: Codex/Claude na MT-SaaS x86). Um stub
#                              claro substitui o agy: missão que invocar 'antigravity'
#                              falha com mensagem, mas codex/claude funcionam.
#      GITORCH_CONTEXT_OUT=DIR coloca o contexto de build em DIR (default: mktemp).
#      GITORCH_BUILD=0         só monta o contexto e NÃO builda (p/ build remoto).
set -euo pipefail

TAG="${1:-localhost/gitorch-agent:latest}"
ENGINE="${GITORCH_CONTAINER_ENGINE:-podman}"
# Resolução do agy:
#  1) GITORCH_AGY_BIN explícito vence sempre.
#  2) GITORCH_ALLOW_NO_AGY=1 (sem bin explícito) => stub, IGNORANDO o agy do PATH
#     (que pode ser de outra arquitetura: aarch64 no host vs x86_64 no alvo).
#  3) padrão: auto-detecta do PATH; erra se faltar.
if [ -n "${GITORCH_AGY_BIN:-}" ]; then
  AGY_BIN="$GITORCH_AGY_BIN"
  [ -f "$AGY_BIN" ] || { echo "erro: GITORCH_AGY_BIN='$AGY_BIN' não existe" >&2; exit 1; }
elif [ "${GITORCH_ALLOW_NO_AGY:-0}" = "1" ]; then
  AGY_BIN=""  # sem agy: um stub será escrito no contexto
else
  AGY_BIN="$(command -v agy || true)"
  if [ -z "$AGY_BIN" ] || [ ! -f "$AGY_BIN" ]; then
    echo "erro: binário do agy não encontrado; defina GITORCH_AGY_BIN (ou GITORCH_ALLOW_NO_AGY=1 p/ buildar sem ele)" >&2
    exit 1
  fi
fi

if [ -n "${GITORCH_CONTEXT_OUT:-}" ]; then
  CONTEXT_DIR="$GITORCH_CONTEXT_OUT"
  mkdir -p "$CONTEXT_DIR"
else
  CONTEXT_DIR="$(mktemp -d)"
  # Só auto-remove o contexto quando é temporário E vamos buildar aqui mesmo.
  [ "${GITORCH_BUILD:-1}" = "1" ] && trap 'rm -rf "$CONTEXT_DIR"' EXIT
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cp "$SCRIPT_DIR/agent-image/Containerfile" "$CONTEXT_DIR/Containerfile"
cp "$SCRIPT_DIR/agent-image/entrypoint.sh" "$CONTEXT_DIR/entrypoint.sh"
if [ -n "$AGY_BIN" ]; then
  cp "$AGY_BIN" "$CONTEXT_DIR/agy"
else
  # Stub: mantém o Containerfile idêntico (COPY agy), mas 'antigravity' indisponível
  # neste nó falha com causa clara. Motores npm (codex/claude) seguem funcionando.
  cat > "$CONTEXT_DIR/agy" <<'STUB'
#!/bin/sh
echo "motor 'antigravity' (agy) indisponível neste nó; use codex ou claude" >&2
exit 127
STUB
  chmod 755 "$CONTEXT_DIR/agy"
fi
# Plugin nativo do GitOrch (rules de identidade/segurança + hooks de gate de
# shell e convergência) que o entrypoint instala no HOME do agy em runtime.
cp -a "$SCRIPT_DIR/agent-image/plugin" "$CONTEXT_DIR/plugin"

# Playbooks do Cadence viram skills nativas do plugin (o agy ativa a skill do
# papel pela description). Gerados no build para a imagem nunca divergir da
# fonte única (packages/cadence/playbooks).
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
for role in ra po sm qa; do
  case "$role" in
    ra) role_name="Research Analyst" ;;
    po) role_name="Product Owner" ;;
    sm) role_name="Scrum Master" ;;
    qa) role_name="Quality Assurance" ;;
  esac
  skill_dir="$CONTEXT_DIR/plugin/gitorch/skills/gitorch-$role"
  mkdir -p "$skill_dir"
  {
    printf -- '---\nname: gitorch-%s-playbook\ndescription: >-\n  Role playbook for the GitOrch %s agent. Use this skill whenever acting as\n  the GitOrch %s in a mission.\n---\n\n' "$role" "$role_name" "$role_name"
    cat "$REPO_ROOT/packages/cadence/playbooks/$role.md"
  } > "$skill_dir/SKILL.md"
done

if [ "${GITORCH_BUILD:-1}" = "0" ]; then
  echo "contexto montado (sem build): $CONTEXT_DIR"
  exit 0
fi

"$ENGINE" build -t "$TAG" -f "$CONTEXT_DIR/Containerfile" "$CONTEXT_DIR"
echo "imagem construída: $TAG"
