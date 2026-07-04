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

# Instala o plugin nativo do GitOrch no HOME do agy. Ele carrega:
#  - rules/: identidade "sou agente GitOrch, não do repo" + guardrail de segurança;
#  - hooks.json: PreToolUse que LIBERA só `gh`/`git` + leitura e NEGA o resto
#    (builds/testes/servidores/rede fora do GitHub) — mata o hang headless e a
#    fuga de sandbox, mantendo poder total no GitHub; PostInvocation que força a
#    convergência (entregar o deliverable em vez de explorar até o timeout).
# O install é local (não precisa de rede) e idempotente por missão. Override:
# GITORCH_AGY_PLUGIN=0. Inofensivo para codex/claude (não leem ~/.gemini).
if [ "${GITORCH_AGY_PLUGIN:-1}" != "0" ] && command -v agy >/dev/null 2>&1 && [ -d /opt/gitorch-plugin/gitorch ]; then
  agy plugin install /opt/gitorch-plugin/gitorch >/dev/null 2>&1 || true

  # settings.json do agy: `autoExecutionPolicy: always-proceed` faz o motor
  # executar ferramentas sem pedir aprovação SEM precisar da flag `--sandbox` na
  # linha de comando. Isso é essencial: o agy lê as próprias flags CLI como se
  # fossem a missão — com `--sandbox` ele escreve "Relatório de Verificação de
  # Sandbox" em vez do deliverable. Sem a flag (e com os hooks fazendo o
  # enforcement de segurança), some a fixação. `allowAgentAccessNonWorkspaceFiles:
  # false` reforça, nativamente, o confinamento de leitura ao workspace.
  # Override: GITORCH_AGY_SETTINGS=0.
  if [ "${GITORCH_AGY_SETTINGS:-1}" != "0" ]; then
    AGY_CFG_DIR="$HOME/.gemini/antigravity-cli"
    AGY_CFG="$AGY_CFG_DIR/settings.json"
    mkdir -p "$AGY_CFG_DIR"
    node -e '
      const fs = require("fs"), p = process.argv[1]
      let s = {}
      try { s = JSON.parse(fs.readFileSync(p, "utf8")) } catch { /* novo arquivo */ }
      s.autoExecutionPolicy = "always-proceed"
      s.allowAgentAccessNonWorkspaceFiles = false
      fs.writeFileSync(p, JSON.stringify(s, null, 2))
    ' "$AGY_CFG" 2>/dev/null || printf '{"autoExecutionPolicy":"always-proceed","allowAgentAccessNonWorkspaceFiles":false}\n' > "$AGY_CFG"
  fi
fi

exec "$@"
