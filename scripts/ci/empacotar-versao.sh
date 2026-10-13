#!/usr/bin/env bash
#
# Empacota a versão: a partir do checkout JÁ construído (não constrói nada),
# monta `gitorch-<commit>.tar.gz` com tudo o que o serviço precisa para rodar
# numa máquina da MESMA arquitetura e do mesmo sistema, sem instalar dependência
# e sem compilar.
#
# Uso:  scripts/ci/empacotar-versao.sh <commit-de-40-hexadecimais> <pasta-de-saida>
#
# Entra no pacote (a lista exata é decidida por empacotar-versao-lista.mjs):
#   - apps/control-plane/dist             o serviço compilado (node dist/index.js);
#   - apps/control-plane/prisma           schema, migrações *-migration.sql e seed;
#   - apps/control-plane/scripts          db-migrate.sh;
#   - apps/control-plane/src (sem testes) o db-migrate.sh lê src/lib/migration-ledger.ts
#                                         por expressão regular e o seed roda com tsx
#                                         importando de src/lib e src/config;
#   - apps/web/out                        o front estático (o servidor o lê de ../web/out);
#   - packages/<x> (só o construído)      os pacotes do monorepo que o serviço usa;
#   - node_modules                        o fecho das dependências do serviço no layout
#                                         do pnpm, com os links simbólicos preservados,
#                                         incluindo o cliente Prisma gerado, os binários
#                                         nativos, prisma e tsx (que o db-migrate.sh executa);
#   - runtime                             script que o agendador chama a partir da raiz;
#   - MANIFESTO.json                      commit, data UTC, node e nodeMajor, arquitetura, sistema e
#                                         componentes com tamanho;
#   - apps/control-plane/dist/commit-publicado.txt  o commit que o serviço informa em
#                                         /api/v1/version.
# Fica de fora: .env*, .git, testes, relatórios, caches e as ferramentas de
# desenvolvimento (teste, lint, compilador).
#
# Na pasta de saída ficam: o tar, `<tar>.sha256` (formato do sha256sum) e uma
# cópia do MANIFESTO.json.
#
# Por que a árvore com links e não `pnpm deploy`: o `pnpm deploy` refaz a
# instalação e perderia o cliente Prisma já gerado e os binários nativos já
# resolvidos neste checkout, e sem `--prod` não há como manter prisma e tsx sem
# arrastar o resto das ferramentas. Empacotar o que este checkout provou
# funcionar é mais simples e é exatamente o que a fumaça do pacote abre depois.
#
# Variável opcional (para testes): EMPACOTAR_RAIZ aponta para outra raiz que não
# a do repositório deste script.
set -euo pipefail

COMMIT="${1:-}"
SAIDA="${2:-}"

falhar() {
  echo "[empacotar] ERRO: $1" >&2
  exit 1
}

if [ -z "$COMMIT" ] || [ -z "$SAIDA" ]; then
  falhar "uso: empacotar-versao.sh <commit-de-40-hexadecimais> <pasta-de-saida>"
fi
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || falhar "commit inválido: precisa ser o sha completo, 40 hexadecimais minúsculos (recebido: '$COMMIT')"

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="${EMPACOTAR_RAIZ:-$(cd "$AQUI/../.." && pwd)}"
[ -d "$RAIZ" ] || falhar "raiz do repositório inexistente: $RAIZ"
RAIZ="$(cd "$RAIZ" && pwd)"

for ferramenta in node tar gzip sha256sum; do
  command -v "$ferramenta" >/dev/null || falhar "ferramenta ausente no PATH: $ferramenta"
done

NOME="gitorch-$COMMIT.tar.gz"
mkdir -p "$SAIDA"
SAIDA="$(cd "$SAIDA" && pwd)"
rm -f "$SAIDA/$NOME" "$SAIDA/$NOME.sha256" "$SAIDA/MANIFESTO.json"

TMP="$(mktemp -d -t gitorch-empacotar-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# 1. Decide o que entra (falha com mensagem clara se faltar componente
#    obrigatório, se houver .env* dentro de componente ou link quebrado).
node "$AQUI/empacotar-versao-lista.mjs" "$RAIZ" "$TMP/lista.txt" "$TMP/componentes.json" \
  || falhar "não foi possível montar a lista do pacote (veja a mensagem acima)"

# 2. Arquivos gerados: commit publicado e manifesto.
PARTE="$TMP/gerado"
mkdir -p "$PARTE/apps/control-plane/dist"
printf '%s\n' "$COMMIT" >"$PARTE/apps/control-plane/dist/commit-publicado.txt"
# Se o build já deixou um commit-publicado.txt, o gerado aqui o substitui.
grep -vxF 'apps/control-plane/dist/commit-publicado.txt' "$TMP/lista.txt" >"$TMP/lista-final.txt" || true

COMMIT="$COMMIT" COMPONENTES="$TMP/componentes.json" SISTEMA="$(uname -s)" ARQUITETURA="$(uname -m)" \
  NODE_VERSAO="$(node -p 'process.version')" \
  node -e '
    const fs = require("fs");
    const componentes = JSON.parse(fs.readFileSync(process.env.COMPONENTES, "utf8"));
    componentes.push({ nome: "gerado-no-empacotamento", arquivos: 2, bytes: 0 });
    const manifesto = {
      commit: process.env.COMMIT,
      geradoEm: new Date().toISOString(),
      node: process.env.NODE_VERSAO,
      nodeMajor: Number(process.env.NODE_VERSAO.replace(/^v/, "").split(".")[0]),
      arquitetura: process.env.ARQUITETURA,
      sistema: process.env.SISTEMA,
      componentes,
    };
    fs.writeFileSync(process.argv[1], JSON.stringify(manifesto, null, 2) + "\n");
  ' "$PARTE/MANIFESTO.json"

# 3. Monta o tar: primeiro o que existe no checkout, depois o que foi gerado.
#    Sem compressão no meio para poder anexar; comprime no fim. Links simbólicos
#    entram como links; hard links do armazém do pnpm viram cópias.
tar --create --file "$TMP/pacote.tar" --directory "$RAIZ" \
  --no-recursion --hard-dereference --owner=0 --group=0 --numeric-owner \
  --files-from "$TMP/lista-final.txt" \
  || falhar "o tar falhou ao ler o checkout"
tar --append --file "$TMP/pacote.tar" --directory "$PARTE" \
  --owner=0 --group=0 --numeric-owner \
  MANIFESTO.json apps/control-plane/dist/commit-publicado.txt \
  || falhar "o tar falhou ao anexar o manifesto"
gzip -n -c "$TMP/pacote.tar" >"$SAIDA/$NOME" || falhar "a compressão falhou"
rm -f "$TMP/pacote.tar"

# 4. Soma de verificação (formato do sha256sum, conferível com `sha256sum -c`)
#    e cópia do manifesto fora do tar.
(cd "$SAIDA" && sha256sum "$NOME" >"$NOME.sha256")
cp "$PARTE/MANIFESTO.json" "$SAIDA/MANIFESTO.json"

TAMANHO="$(stat -c %s "$SAIDA/$NOME")"
echo "[empacotar] pacote pronto: $SAIDA/$NOME ($TAMANHO bytes)"
echo "[empacotar] soma: $(cut -d' ' -f1 "$SAIDA/$NOME.sha256")"
