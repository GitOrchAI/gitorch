#!/usr/bin/env bash
#
# Teste do empacotador (empacotar-versao.sh) contra uma árvore MÍNIMA de
# mentira: arquivos minúsculos nos caminhos certos e links simbólicos como os
# que o pnpm cria. Não constrói nada e não precisa de rede nem de banco.
#
# Uso:  scripts/ci/empacotar-versao.test.sh
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EMPACOTAR="$AQUI/empacotar-versao.sh"
COMMIT="a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"

TMP="$(mktemp -d -t gitorch-empacotar-teste-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

FALHAS=0
PASSOS=0
ok() { PASSOS=$((PASSOS + 1)); echo "  ok   - $1"; }
nok() { FALHAS=$((FALHAS + 1)); echo "  FALHA - $1" >&2; }
confere() { # descrição, comando...
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then ok "$desc"; else nok "$desc"; fi
}
confere_nao() { # descrição, comando...
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then nok "$desc"; else ok "$desc"; fi
}

# Monta a árvore de mentira em $1.
monta_arvore() {
  local r="$1"
  local cp="$r/apps/control-plane"
  local v="$r/node_modules/.pnpm"
  mkdir -p "$cp"/{dist/services,node_modules/@gitorch,node_modules/.bin,prisma,scripts,src/lib}
  mkdir -p "$r/packages/agents"/{dist,src,node_modules} "$r/apps/web/out/setup" "$r/runtime" "$r/.git"
  mkdir -p "$v/fastify@1/node_modules/fastify" "$v/pino@1/node_modules/pino"
  mkdir -p "$v/zod@1/node_modules/zod" "$v/prisma@1/node_modules/prisma" "$v/tsx@1/node_modules/tsx"
  mkdir -p "$v/vitest@1/node_modules/vitest" "$v/node_modules"

  cat >"$cp/package.json" <<'JSON'
{ "name": "@gitorch/control-plane", "type": "module",
  "dependencies": { "fastify": "1.0.0", "@gitorch/agents": "workspace:*" },
  "devDependencies": { "prisma": "1.0.0", "tsx": "1.0.0", "vitest": "1.0.0" } }
JSON
  echo '{}' >"$cp/tsconfig.json"
  echo 'console.log("sobe")' >"$cp/dist/index.js"
  echo 'export {}' >"$cp/dist/services/a.js"
  echo 'teste' >"$cp/dist/services/a.test.js"
  echo 'schema' >"$cp/prisma/schema.prisma"
  echo 'select 1;' >"$cp/prisma/billing-migration.sql"
  echo 'seed' >"$cp/prisma/seed.ts"
  printf '#!/usr/bin/env bash\necho migra\n' >"$cp/scripts/db-migrate.sh"
  chmod +x "$cp/scripts/db-migrate.sh"
  echo "'billing-migration.sql'" >"$cp/src/lib/migration-ledger.ts"
  echo 'teste' >"$cp/src/lib/migration-ledger.test.ts"

  echo '{ "name": "@gitorch/agents", "dependencies": { "zod": "1.0.0" }, "devDependencies": { "vitest": "1.0.0" } }' \
    >"$r/packages/agents/package.json"
  echo 'agents' >"$r/packages/agents/dist/index.js"
  echo 'fonte' >"$r/packages/agents/src/index.ts"

  echo 'fastify' >"$v/fastify@1/node_modules/fastify/index.js"
  echo 'pino' >"$v/pino@1/node_modules/pino/index.js"
  echo 'zod' >"$v/zod@1/node_modules/zod/index.js"
  echo 'prisma' >"$v/prisma@1/node_modules/prisma/index.js"
  echo 'tsx' >"$v/tsx@1/node_modules/tsx/index.js"
  echo 'vitest' >"$v/vitest@1/node_modules/vitest/index.js"
  # Um .env de terceiro dentro do repositório virtual do pnpm não é do projeto.
  echo 'exemplo' >"$v/pino@1/node_modules/pino/.env.example"
  ln -s ../../pino@1/node_modules/pino "$v/fastify@1/node_modules/pino"
  ln -s ../../zod@1/node_modules/zod "$v/node_modules/zod"
  ln -s ../../vitest@1/node_modules/vitest "$v/node_modules/vitest"

  ln -s ../../../node_modules/.pnpm/fastify@1/node_modules/fastify "$cp/node_modules/fastify"
  ln -s ../../../node_modules/.pnpm/prisma@1/node_modules/prisma "$cp/node_modules/prisma"
  ln -s ../../../node_modules/.pnpm/tsx@1/node_modules/tsx "$cp/node_modules/tsx"
  ln -s ../../../node_modules/.pnpm/vitest@1/node_modules/vitest "$cp/node_modules/vitest"
  ln -s ../../../../packages/agents "$cp/node_modules/@gitorch/agents"
  ln -s ../../../node_modules/.pnpm/zod@1/node_modules/zod "$r/packages/agents/node_modules/zod"
  echo 'prisma-bin' >"$cp/node_modules/.bin/prisma"
  echo 'tsx-bin' >"$cp/node_modules/.bin/tsx"

  echo '<html>front</html>' >"$r/apps/web/out/index.html"
  echo '<html>setup</html>' >"$r/apps/web/out/setup/index.html"
  echo 'print(1)' >"$r/runtime/run_antigravity_sdk.py"

  # Segredo plantado FORA de qualquer componente, e pasta .git.
  echo 'SEGREDO=1' >"$r/.env"
  echo 'ref' >"$r/.git/HEAD"
}

roda() { # raiz, commit, saída
  EMPACOTAR_RAIZ="$1" bash "$EMPACOTAR" "$2" "$3"
}

echo "== caso 1: empacotamento feliz =="
R1="$TMP/arvore-feliz"
S1="$TMP/saida-feliz"
monta_arvore "$R1"
if roda "$R1" "$COMMIT" "$S1" >"$TMP/feliz.log" 2>&1; then
  ok "empacotador terminou com sucesso"
else
  nok "empacotador terminou com sucesso (log em seguida)"
  cat "$TMP/feliz.log" >&2
fi
TAR="$S1/gitorch-$COMMIT.tar.gz"
confere "tar criado" test -s "$TAR"
confere "soma conferida por sha256sum -c" bash -c "cd '$S1' && sha256sum -c 'gitorch-$COMMIT.tar.gz.sha256'"
confere "cópia do manifesto fora do tar" test -s "$S1/MANIFESTO.json"

LISTA="$TMP/lista.txt"
if ! tar -tzf "$TAR" >"$LISTA"; then nok "tar lista o conteúdo do pacote"; fi
tem() { grep -qE "$1" "$LISTA"; }
confere "MANIFESTO.json dentro do tar" tem '^(\./)?MANIFESTO\.json$'
confere "commit-publicado.txt dentro do tar" tem '^(\./)?apps/control-plane/dist/commit-publicado\.txt$'
confere "dist/index.js presente" tem '^(\./)?apps/control-plane/dist/index\.js$'
confere "front presente" tem '^(\./)?apps/web/out/index\.html$'
confere "db-migrate.sh presente" tem '^(\./)?apps/control-plane/scripts/db-migrate\.sh$'
confere "migration-ledger.ts presente" tem '^(\./)?apps/control-plane/src/lib/migration-ledger\.ts$'
confere "seed e schema do prisma presentes" bash -c "grep -qE 'prisma/seed\.ts$' '$LISTA' && grep -qE 'prisma/schema\.prisma$' '$LISTA'"
confere "pacote do monorepo construído presente" tem '^(\./)?packages/agents/dist/index\.js$'
confere "dependência de produção presente" tem 'node_modules/\.pnpm/fastify@1/node_modules/fastify/index\.js$'
confere "dependência da dependência presente" tem 'node_modules/\.pnpm/pino@1/node_modules/pino/index\.js$'
confere "prisma e tsx (db-migrate.sh) presentes" bash -c "grep -qE '\.pnpm/prisma@1/' '$LISTA' && grep -qE '\.pnpm/tsx@1/' '$LISTA'"
confere_nao "nada de .env no tar" tem '(^|/)\.env'
confere_nao "nada de .git no tar" tem '(^|/)\.git(/|$)'
confere_nao "nada de *.test.* no tar" tem '\.test\.'
confere_nao "fonte do pacote do monorepo fora do tar" tem '^(\./)?packages/agents/src/'
confere_nao "devDependency que o serviço não usa fora do tar" tem '\.pnpm/vitest@1/'

# Links simbólicos preservados como links (não viram cópia).
TV="$TMP/tar-verboso.txt"
if ! tar -tvzf "$TAR" >"$TV"; then nok "tar lista o conteúdo detalhado do pacote"; fi
confere "link do pnpm preservado" grep -qE 'apps/control-plane/node_modules/fastify -> \.\./\.\./\.\./node_modules/\.pnpm/fastify@1/node_modules/fastify' "$TV"
confere "link entre pacotes do monorepo preservado" grep -qE 'apps/control-plane/node_modules/@gitorch/agents -> \.\./\.\./\.\./\.\./packages/agents' "$TV"

# Conteúdo do manifesto.
MAN="$S1/MANIFESTO.json"
confere "manifesto com o commit completo" node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (m.commit !== process.argv[2]) process.exit(1);' "$MAN" "$COMMIT"
confere "manifesto com a arquitetura desta máquina" node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (m.arquitetura !== process.argv[2]) process.exit(1);' "$MAN" "$(uname -m)"
confere "manifesto com node, sistema e data UTC" node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!/^v\d+\./.test(m.node) || !m.sistema || !/Z$/.test(m.geradoEm)) process.exit(1);' "$MAN"
confere "manifesto declara nodeMajor igual ao major do node desta máquina" node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(m.nodeMajor) || m.nodeMajor !== major) process.exit(1);
  if (!m.node.startsWith("v" + m.nodeMajor + ".")) process.exit(1);' "$MAN"
confere_nao "manifesto não tem endereço (nenhuma URL em campo algum)" grep -qiE 'https?://|API_URL' "$MAN"
MAN_DO_TAR="$TMP/manifesto-do-tar.json"
if ! tar -xzOf "$TAR" MANIFESTO.json >"$MAN_DO_TAR"; then nok "tar extrai o manifesto do pacote"; fi
confere_nao "manifesto do tar também não tem endereço" grep -qiE 'https?://|API_URL' "$MAN_DO_TAR"
confere "manifesto lista componentes com tamanho" node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const nomes = m.componentes.map((c) => c.nome);
  for (const n of ["control-plane-dist", "control-plane-prisma", "front-web", "dependencias"]) {
    if (!nomes.includes(n)) process.exit(1);
  }
  if (!m.componentes.every((c) => Number.isInteger(c.bytes) && c.bytes >= 0)) process.exit(1);' "$MAN"
confere "manifesto do tar igual à cópia de fora" cmp -s "$MAN_DO_TAR" "$MAN"

# O pacote aberto numa pasta vazia traz o mesmo commit lido pelo serviço.
ABERTO="$TMP/aberto"
mkdir -p "$ABERTO"
if ! tar -xzf "$TAR" -C "$ABERTO"; then nok "tar abre o pacote numa pasta vazia"; fi
confere "commit-publicado.txt aberto contém o commit" bash -c "[ \"\$(cat '$ABERTO/apps/control-plane/dist/commit-publicado.txt')\" = '$COMMIT' ]"
confere "link do pnpm continua resolvendo depois de aberto" test -f "$ABERTO/apps/control-plane/node_modules/fastify/index.js"
confere "dependência da dependência resolve depois de aberto" test -f "$ABERTO/apps/control-plane/node_modules/fastify/../pino/index.js"
confere "db-migrate.sh continua executável" test -x "$ABERTO/apps/control-plane/scripts/db-migrate.sh"

echo "== caso 2: falta dist/index.js =="
R2="$TMP/arvore-sem-dist"
monta_arvore "$R2"
rm "$R2/apps/control-plane/dist/index.js"
if roda "$R2" "$COMMIT" "$TMP/saida-sem-dist" >"$TMP/sem-dist.log" 2>&1; then
  nok "deveria falhar sem dist/index.js"
else
  ok "falha sem dist/index.js"
fi
confere "mensagem em português cita dist/index.js" grep -q 'dist/index.js' "$TMP/sem-dist.log"
confere_nao "nenhum tar deixado para trás" test -e "$TMP/saida-sem-dist/gitorch-$COMMIT.tar.gz"

echo "== caso 3: commit inválido =="
R3="$TMP/arvore-commit"
monta_arvore "$R3"
for ruim in "abc123" "ZZZZ3d4e5f60718293a4b5c6d7e8f9012345678" "${COMMIT}0" ""; do
  if roda "$R3" "$ruim" "$TMP/saida-commit" >"$TMP/commit.log" 2>&1; then
    nok "deveria recusar o commit '$ruim'"
  else
    ok "recusa o commit '$ruim'"
  fi
done
confere "mensagem cita os 40 hexadecimais" grep -q '40' "$TMP/commit.log"

echo "== caso 4: .env dentro de um componente =="
R4="$TMP/arvore-env"
monta_arvore "$R4"
echo 'SEGREDO=2' >"$R4/apps/control-plane/dist/.env.production"
if roda "$R4" "$COMMIT" "$TMP/saida-env" >"$TMP/env.log" 2>&1; then
  nok "deveria falhar com .env dentro do componente"
else
  ok "falha com .env dentro do componente"
fi
confere "mensagem cita o arquivo .env" grep -q '\.env\.production' "$TMP/env.log"
confere_nao "nenhum tar deixado para trás" test -e "$TMP/saida-env/gitorch-$COMMIT.tar.gz"

echo "== caso 5: falta o front =="
R5="$TMP/arvore-sem-front"
monta_arvore "$R5"
rm -rf "$R5/apps/web/out"
if roda "$R5" "$COMMIT" "$TMP/saida-sem-front" >"$TMP/sem-front.log" 2>&1; then
  nok "deveria falhar sem o front"
else
  ok "falha sem o front"
fi

echo "== caso 6: erro ao filtrar a lista não pode virar pacote pronto =="
# Ferramentas de mentira à frente no PATH: simulam falha de leitura/escrita
# no ponto do filtro da lista (grep e sed) sem depender de permissão do disco.
R6="$TMP/arvore-filtro"
monta_arvore "$R6"
FALSAS="$TMP/ferramentas-falsas"
mkdir -p "$FALSAS"
for f in grep sed; do
  printf '#!/usr/bin/env bash\necho "%s falso: erro de leitura" >&2\nexit 2\n' "$f" >"$FALSAS/$f"
  chmod +x "$FALSAS/$f"
done
rc=0
PATH="$FALSAS:$PATH" roda "$R6" "$COMMIT" "$TMP/saida-filtro" >"$TMP/filtro.log" 2>&1 || rc=$?
if [ "$rc" -ne 0 ]; then ok "falha (exit $rc) quando o filtro da lista dá erro"; else nok "deveria falhar quando o filtro da lista dá erro"; fi
confere_nao "não diz 'pacote pronto' com o filtro falhando" grep -q 'pacote pronto' "$TMP/filtro.log"
confere_nao "nenhum tar deixado para trás com o filtro falhando" test -e "$TMP/saida-filtro/gitorch-$COMMIT.tar.gz"

echo "== caso 7: lista final vazia =="
# Filtro que "termina bem" mas não devolve nada: o empacotador não pode seguir.
R7="$TMP/arvore-lista-vazia"
monta_arvore "$R7"
VAZIAS="$TMP/ferramentas-vazias"
mkdir -p "$VAZIAS"
for f in grep sed; do
  printf '#!/usr/bin/env bash\nexit 0\n' >"$VAZIAS/$f"
  chmod +x "$VAZIAS/$f"
done
rc=0
PATH="$VAZIAS:$PATH" roda "$R7" "$COMMIT" "$TMP/saida-vazia" >"$TMP/vazia.log" 2>&1 || rc=$?
if [ "$rc" -ne 0 ]; then ok "falha (exit $rc) com a lista final vazia"; else nok "deveria falhar com a lista final vazia"; fi
confere "mensagem em português diz que a lista ficou vazia" grep -q 'lista final do pacote ficou vazia' "$TMP/vazia.log"
confere_nao "não diz 'pacote pronto' com a lista vazia" grep -q 'pacote pronto' "$TMP/vazia.log"

echo
echo "passos ok: $PASSOS, falhas: $FALHAS"
[ "$FALHAS" -eq 0 ]
