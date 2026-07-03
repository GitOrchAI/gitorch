#!/usr/bin/env bash
# Entrypoint das missões: as credenciais dos motores entram montadas
# SOMENTE-LEITURA em /run/gitorch-credentials (o original no host nunca é
# tocado). Aqui elas são copiadas para o HOME gravável e efêmero do container,
# para que os CLIs possam ler a autenticação E escrever seus arquivos de apoio
# (helpers, cache, refresh de token) sem vazar nada de volta ao host.
set -euo pipefail

CRED_SRC="/run/gitorch-credentials"
if [ -d "$CRED_SRC" ]; then
  cp -a "$CRED_SRC/." "$HOME"/ 2>/dev/null || true
  chmod -R u+rwX "$HOME" 2>/dev/null || true
fi

exec "$@"
