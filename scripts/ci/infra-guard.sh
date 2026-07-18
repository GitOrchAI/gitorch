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
# "manifest.json" soltos. O público já tem `scripts/infra/` (tooling legítimo
# de build de agent image, referenciado em comentários/docs) e apps/web é
# Next.js (public/manifest.json de PWA é convenção normal). Um padrão solto
# nesses dois colidiria com conteúdo público real. Por isso os padrões abaixo
# são escopados ao contexto do repo privado (gitorch-cloud / engine version).
#
# ESCAPE INLINE: uma linha que contenha o marcador `infra-guard-allow` é
# isentada (use com parcimônia e justificativa no próprio comentário).
#
# Uso:
#   scripts/ci/infra-guard.sh                 # gate diff (base = origin/main)
#   INFRA_GUARD_BASE=<sha> scripts/ci/infra-guard.sh
#   scripts/ci/infra-guard.sh --all           # auditoria completa
set -euo pipefail

MODE="diff"
BASE_REF="${INFRA_GUARD_BASE:-origin/main}"
DIFF_FILE=""
for arg in "$@"; do
  case "$arg" in
    --all) MODE="all" ;;
    --base=*) BASE_REF="${arg#--base=}" ;;
    # Varre um unified diff já pronto (arquivo ou '-' para stdin) em vez de
    # chamá-lo do git. Serve para testes e para um hook pre-receive.
    --diff-file=*) DIFF_FILE="${arg#--diff-file=}" ;;
    -h | --help)
      sed -n '2,37p' "$0"
      exit 0
      ;;
    *)
      echo "infra-guard: argumento desconhecido: $arg" >&2
      exit 2
      ;;
  esac
done

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
  'gitorch-cloud[/-]infra'                                                     # infra/ do repo privado (NÃO usar "infra/" solto — colide com scripts/infra/ público, tooling legítimo de agent image)
)

# Junta a denylist numa única alternação ERE.
JOINED="$(
  IFS='|'
  printf '%s' "${PATTERNS[*]}"
)"

# Arquivos que o guard NÃO varre — contêm os próprios padrões da denylist e
# casariam a si mesmos. Também exclui o lockfile (ruído, sem infra nossa).
EXCLUDES=(
  ':(exclude)scripts/ci/infra-guard.sh'
  ':(exclude).github/workflows/infra-guard.yml'
  ':(exclude)pnpm-lock.yaml'
)

ALLOW_MARK='infra-guard-allow'

# Emite `arquivo:linha:conteúdo` para cada LINHA ADICIONADA no diff vs a base.
scan_diff() {
  if [[ -n "$DIFF_FILE" ]]; then
    if [[ "$DIFF_FILE" == "-" ]]; then cat; else cat "$DIFF_FILE"; fi
  else
    local base="$BASE_REF"
    if ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null 2>&1; then
      base="$(git rev-parse --verify --quiet 'HEAD~1^{commit}' || git rev-parse HEAD)"
    fi
    git diff --unified=0 "${base}...HEAD" -- . "${EXCLUDES[@]}"
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

# Coleta as linhas candidatas conforme o modo, aplica a denylist e o escape.
if [[ "$MODE" == "all" ]]; then
  candidates="$(git grep -nIE "$JOINED" -- . "${EXCLUDES[@]}" 2>/dev/null || true)"
else
  candidates="$(scan_diff | grep -E "$JOINED" || true)"
fi

matches="$(printf '%s\n' "$candidates" | grep -Fv "$ALLOW_MARK" | sed '/^[[:space:]]*$/d' || true)"

if [[ -n "$matches" ]]; then
  {
    echo "❌ infra-guard: padrão de infra proibido encontrado (modo: $MODE)."
    echo "   Segredos/IPs/hostnames/paths da nossa VM não podem entrar no repo público."
    echo "   Se for legítimo e público, use env var (ex.: default /var/lib/gitorch) ou"
    echo "   marque a linha com 'infra-guard-allow' justificando. Ocorrências:"
    echo
    printf '%s\n' "$matches"
  } >&2
  exit 1
fi

echo "✓ infra-guard: nenhum vazamento de infra novo detectado (modo: $MODE)."
