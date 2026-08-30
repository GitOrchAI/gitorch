#!/usr/bin/env bash
#
# infra-guard — barra vazamento de infra da NOSSA VM para o repo público (OSS).
#
# O repositório é open-core: o CÓDIGO é aberto, mas segredos, IPs internos,
# hostnames e paths absolutos da nossa VM NÃO podem entrar no git. Este guard
# mecaniza essa fronteira com uma denylist de padrões de infra.
#
# Além da VM, existe agora um repo IRMÃO privado (gitorch-cloud) com a infra
# de nuvem/SaaS. O público não pode citar esse repo, seus arquivos de versão
# de motores nem seus caminhos de infra — ver denylist abaixo.
#
# DUAS CAMADAS de proteção:
#   1) CONTEÚDO — denylist de padrões (IPs, hostnames, paths, chave privada e
#      tokens/credenciais: Anthropic, GitHub, AWS, Slack) nas linhas do diff.
#   2) CAMINHO — barra a própria PRESENÇA no git de artefatos locais de
#      VM/agente (.claude/, .gemini/, .cursor/, .phase/, scratchpad/,
#      graphify-out/, *.sqlite), mesmo que o conteúdo não contenha segredo.
#      É defesa em profundidade além do .gitignore: um `git add -f` forçado
#      ainda seria pego aqui, no CI.
#
# MODOS:
#   (padrão)  diff  — varre só as LINHAS ADICIONADAS vs a base (INFRA_GUARD_BASE
#                     ou origin/main). Pega vazamentos NOVOS sem quebrar por
#                     débito pré-existente em arquivos que a PR nem tocou.
#   --all           — varredura completa de todos os arquivos rastreados. Para
#                     auditoria manual (reporta o que já vazou); NÃO é o gate.
#
# EXCEÇÃO DOCUMENTADA: '/var/lib/gitorch/...' é default de env var no código
# (environment.ts, cortex.ts, scheduler.ts, local-provider.ts) — path FHS
# genérico e público, NÃO é vazamento; por isso não está na denylist.
#
# EXCEÇÃO DOCUMENTADA: NÃO existe um padrão bare para "infra/" ou
# "manifest.json" soltos. `scripts/infra/` migrou pro privado na task t8 (o
# público hoje só cita o caminho antigo em comentários/docs, em passado), mas
# um "infra/" solto na denylist ainda colidiria com tooling público legítimo
# que reapareça (ex.: self-host /init da F3) e apps/web é Next.js
# (public/manifest.json de PWA é convenção normal). Por isso os padrões
# abaixo são escopados ao contexto do repo privado (gitorch-cloud / engine
# version) em vez de bare.
#
# EXCEÇÃO DOCUMENTADA: os padrões de token/credencial (camada 1) NÃO varrem
# '**/*.example', '**/__fixtures__/**' nem '**/*.test.ts' — são tokens FAKE de
# propósito (ex.: 'sk-ant-oat01-FAKE' em testes, placeholders em .env.example,
# stdout capturado/redigido em fixture). O check de CAMINHO (camada 2), por
# ser sobre o arquivo em si e não sobre conteúdo, NÃO usa essa exceção: um
# '.claude/x.test.ts' sendo adicionado continua barrado.
#
# ESCAPE INLINE: uma linha que contenha o marcador `infra-guard-allow` é
# isentada do check de CONTEÚDO (use com parcimônia e justificativa no próprio
# comentário). Não existe escape para o check de CAMINHO — esses diretórios/
# extensão nunca devem ser rastreados no git, ponto.
#
# Uso:
#   scripts/ci/infra-guard.sh                 # gate diff (base = origin/main)
#   INFRA_GUARD_BASE=<sha> scripts/ci/infra-guard.sh
#   scripts/ci/infra-guard.sh --all           # auditoria completa
#   scripts/ci/infra-guard.sh --diff-file=-   # lê um unified diff do stdin (testes)
set -euo pipefail

MODE="diff"
BASE_REF="${INFRA_GUARD_BASE:-origin/main}"
if [[ "$BASE_REF" =~ ^0+$ ]]; then
  BASE_REF="origin/main"
fi
DIFF_FILE=""
for arg in "$@"; do
  case "$arg" in
    --all) MODE="all" ;;
    --base=*) BASE_REF="${arg#--base=}" ;;
    # Varre um unified diff já pronto (arquivo ou '-' para stdin) em vez de
    # chamá-lo do git. Serve para testes e para um hook pre-receive.
    --diff-file=*) DIFF_FILE="${arg#--diff-file=}" ;;
    -h | --help)
      sed -n '2,58p' "$0"
      exit 0
      ;;
    *)
      echo "infra-guard: argumento desconhecido: $arg" >&2
      exit 2
      ;;
  esac
done

# stdin só pode ser lido uma vez: se vier de '--diff-file=-', captura logo aqui
# (uma única leitura) para os dois checks (conteúdo e caminho) reutilizarem.
# Não faz sentido em --all (ignora DIFF_FILE) — não trava esperando stdin.
STDIN_DIFF=""
if [[ "$MODE" != "all" && "$DIFF_FILE" == "-" ]]; then
  STDIN_DIFF="$(cat)"
fi

# Fronteiras de octeto: matam falsos-positivos de dados decimais/coordenadas
# (ex.: paths de SVG com "10.9.6.1") exigindo que o IP não esteja embutido numa
# sequência decimal maior — à esquerda e à direita não pode haver dígito/ponto.
L='(^|[^0-9.])'
R='([^0-9.]|$)'

PATTERNS=(
  '[A-Za-z0-9_-]+\.ts\.net'                                                    # Tailscale MagicDNS
  "${L}100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}${R}" # Tailscale CGNAT 100.64.0.0/10
  "${L}192\.168\.[0-9]{1,3}\.[0-9]{1,3}${R}"                                    # LAN privada 192.168/16
  "${L}172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}${R}"                  # LAN privada 172.16/12
  "${L}10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}${R}"                              # LAN privada 10/8
  '/home/ubuntu'                                                                # HOME da nossa VM
  '/mnt/gitorch-vault'                                                          # mount do nosso vault
  'BEGIN ([A-Z0-9]+ )*PRIVATE KEY'                                             # bloco de chave privada
  'gitorch-cloud'                                                              # repo IRMÃO privado — nunca citar no público
  'engines?[/-]manifest\.json'                                                 # manifest de versão de motores (arquivo do privado; NÃO usar "manifest.json" solto — colide com public/manifest.json de PWA em apps/web)
  'gitorch-cloud[/-]infra'                                                     # infra/ do repo privado (NÃO usar "infra/" solto — colidiria com tooling público legítimo que venha a existir, ex.: self-host /init)
  'sk-ant-[A-Za-z0-9_-]{8,}'                                                   # chave/token Anthropic (API key ou OAuth Claude Code, ex.: sk-ant-oat01-...)
  'gh[pousr]_[A-Za-z0-9]{20,}'                                                 # token GitHub (ghp_ pessoal, gho_ oauth, ghu_ user-to-server, ghs_ server-to-server, ghr_ refresh)
  'AKIA[0-9A-Z]{12,}'                                                          # AWS access key id
  'xox[baprs]-[A-Za-z0-9-]{10,}'                                               # token Slack (bot/app/user/refresh/legacy)
)

# Junta a denylist numa única alternação ERE.
JOINED="$(
  IFS='|'
  printf '%s' "${PATTERNS[*]}"
)"

# Arquivos que o CHECK DE CONTEÚDO não varre — os dois primeiros contêm os
# próprios padrões da denylist e casariam a si mesmos; o lockfile é ruído sem
# infra nossa; os três últimos legitimamente citam tokens FAKE (exemplo,
# fixture de teste, teste automatizado) — ver exceção documentada acima. Isso
# NÃO afeta o check de CAMINHO (scan_paths), que é independente.
EXCLUDES=(
  ':(exclude)scripts/ci/infra-guard.sh'
  ':(exclude).github/workflows/infra-guard.yml'
  ':(exclude)pnpm-lock.yaml'
  ':(exclude)**/*.example'
  ':(exclude)**/__fixtures__/**'
  ':(exclude)**/*.test.ts'
)

ALLOW_MARK='infra-guard-allow'

# Executa o git diff tentando base...HEAD (triplo-ponto), base..HEAD (duplo-ponto),
# e fallbacks seguros para evitar falha do pipefail se a base não puder ser diffed.
run_git_diff() {
  local base="$1"
  shift
  if git diff --unified=0 "${base}...HEAD" "$@" 2>/dev/null; then
    return 0
  fi
  if git diff --unified=0 "${base}..HEAD" "$@" 2>/dev/null; then
    return 0
  fi
  local fallback
  fallback="$(git rev-parse --verify --quiet 'HEAD~1^{commit}' || git rev-parse HEAD)"
  if git diff --unified=0 "${fallback}...HEAD" "$@" 2>/dev/null; then
    return 0
  fi
  git diff --unified=0 HEAD "$@" 2>/dev/null || true
}

# Emite `arquivo:linha:conteúdo` para cada LINHA ADICIONADA no diff vs a base.
scan_diff() {
  if [[ -n "$DIFF_FILE" ]]; then
    if [[ "$DIFF_FILE" == "-" ]]; then printf '%s\n' "$STDIN_DIFF"; else cat "$DIFF_FILE"; fi
  else
    local base="$BASE_REF"
    if [[ "$base" =~ ^0+$ ]] || ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null 2>&1; then
      base="$(git rev-parse --verify --quiet 'HEAD~1^{commit}' || git rev-parse HEAD)"
    fi
    run_git_diff "$base" -- . "${EXCLUDES[@]}"
  fi | awk '
    /^\+\+\+ b\// { file = substr($0, 7); next }
    /^\+\+\+ /    { file = "";            next }
    /^@@ / {
      match($0, /\+[0-9]+/)
      newline = substr($0, RSTART + 1, RLENGTH - 1) + 0
      next
    }
    /^\+/ {
      if (file != "") print file ":" newline ":" substr($0, 2)
      newline++
      next
    }
  '
}

# --- Camada 2: check de CAMINHO (defesa em profundidade) --------------------
# Barra a própria presença no git de artefatos locais de VM/agente, sem olhar
# conteúdo. NÃO usa os EXCLUDES de teste/fixture do check de conteúdo — um
# '.claude/x.test.ts' sendo adicionado deve continuar barrado por aqui.
PATH_DENY_RE='(^(\.claude|\.gemini|\.cursor|\.phase|scratchpad|graphify-out)/)|(\.sqlite$)'

# Emite um path por linha: no modo diff, arquivos com linha NOVA (+++ b/...)
# no diff (real ou vindo de --diff-file); no modo --all, todo arquivo já
# rastreado no repo (git ls-files).
scan_paths() {
  if [[ "$MODE" == "all" ]]; then
    git ls-files
    return
  fi
  if [[ -n "$DIFF_FILE" ]]; then
    if [[ "$DIFF_FILE" == "-" ]]; then printf '%s\n' "$STDIN_DIFF"; else cat "$DIFF_FILE"; fi
  else
    local base="$BASE_REF"
    if [[ "$base" =~ ^0+$ ]] || ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null 2>&1; then
      base="$(git rev-parse --verify --quiet 'HEAD~1^{commit}' || git rev-parse HEAD)"
    fi
    run_git_diff "$base" -- .
  fi | grep -E '^\+\+\+ b/' | sed -E 's#^\+\+\+ b/##'
}

# Coleta as linhas candidatas conforme o modo, aplica a denylist e o escape.
if [[ "$MODE" == "all" ]]; then
  candidates="$(git grep -nIE "$JOINED" -- . "${EXCLUDES[@]}" 2>/dev/null || true)"
else
  candidates="$(scan_diff | grep -E "$JOINED" || true)"
fi

matches="$(printf '%s\n' "$candidates" | grep -Fv "$ALLOW_MARK" | sed '/^[[:space:]]*$/d' || true)"

path_matches="$(scan_paths | grep -E "$PATH_DENY_RE" | sed '/^[[:space:]]*$/d' || true)"

if [[ -n "$matches" || -n "$path_matches" ]]; then
  {
    if [[ -n "$matches" ]]; then
      echo "❌ infra-guard: padrão de infra proibido encontrado (modo: $MODE)."
      echo "   Segredos/IPs/hostnames/paths da nossa VM não podem entrar no repo público."
      echo "   Se for legítimo e público, use env var (ex.: default /var/lib/gitorch) ou"
      echo "   marque a linha com 'infra-guard-allow' justificando. Ocorrências:"
      echo
      printf '%s\n' "$matches"
    fi
    if [[ -n "$path_matches" ]]; then
      [[ -n "$matches" ]] && echo
      echo "❌ infra-guard: artefato local de VM/agente não pode entrar no git — está no .gitignore (modo: $MODE)."
      echo "   Caminhos sob .claude/, .gemini/, .cursor/, .phase/, scratchpad/ ou"
      echo "   graphify-out/, e qualquer *.sqlite, são locais/efêmeros da VM/agente —"
      echo "   nunca do repo público. Remova do commit (git rm --cached <arquivo>)."
      echo "   Ocorrências:"
      echo
      printf '%s\n' "$path_matches"
    fi
  } >&2
  exit 1
fi

echo "✓ infra-guard: nenhum vazamento de infra novo detectado (modo: $MODE)."
