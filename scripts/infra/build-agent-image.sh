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

"$ENGINE" build -t "$TAG" -f "$CONTEXT_DIR/Containerfile" "$CONTEXT_DIR"
echo "imagem construída: $TAG"
