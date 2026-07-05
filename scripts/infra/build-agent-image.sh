#!/usr/bin/env bash
# Constrói a imagem de execução das missões (gitorch-agent).
# Uso: scripts/infra/build-agent-image.sh [tag]
# Env: GITORCH_AGY_BIN (caminho do binário agy no host; default: `command -v agy`)
#      GITORCH_CONTAINER_ENGINE (podman|docker; default: podman)
set -euo pipefail

TAG="${1:-localhost/gitorch-agent:latest}"
ENGINE="${GITORCH_CONTAINER_ENGINE:-podman}"
AGY_BIN="${GITORCH_AGY_BIN:-$(command -v agy || true)}"

if [ -z "$AGY_BIN" ] || [ ! -f "$AGY_BIN" ]; then
  echo "erro: binário do agy não encontrado; defina GITORCH_AGY_BIN" >&2
  exit 1
fi

CONTEXT_DIR="$(mktemp -d)"
trap 'rm -rf "$CONTEXT_DIR"' EXIT

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cp "$SCRIPT_DIR/agent-image/Containerfile" "$CONTEXT_DIR/Containerfile"
cp "$SCRIPT_DIR/agent-image/entrypoint.sh" "$CONTEXT_DIR/entrypoint.sh"
cp "$AGY_BIN" "$CONTEXT_DIR/agy"
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

"$ENGINE" build -t "$TAG" -f "$CONTEXT_DIR/Containerfile" "$CONTEXT_DIR"
echo "imagem construída: $TAG"
