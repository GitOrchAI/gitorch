# CLAUDE.md — GitOrch

Contexto do repositório para o Claude Code. O guia completo de comandos, estrutura e
portão de CI está em [`AGENTS.md`](./AGENTS.md) — este arquivo cobre o que é específico
de trabalhar neste repo com worktrees.

## Trabalhando em worktree (o caminho normal deste projeto)

A lei do projeto é **1 pedido = 1 branch em worktree**. Uma worktree recém-criada não é
um clone completo: ela nasce **sem `node_modules`** e sem nada que o `pnpm install` gere.
Sem ligar as dependências, nada roda — nem o portão de pre-commit, nem os testes.

```bash
git -C <checkout-principal> worktree add -b <branch> <caminho-da-worktree> origin/main
cd <caminho-da-worktree>

# Ligue os node_modules do checkout principal (rode de dentro da worktree):
M=$(git worktree list --porcelain | head -1 | cut -d" " -f2)
for d in . apps/control-plane apps/web packages/cadence packages/agents \
         packages/cgc packages/github-sync .github/scripts; do
  [ -d "$M/$d/node_modules" ] && [ ! -e "$d/node_modules" ] \
    && ln -s "$M/$d/node_modules" "$d/node_modules"
done
```

`node_modules` está no `.gitignore` **sem barra no fim** de propósito: com barra
(`node_modules/`) a regra só casa com diretório de verdade, e o symlink da worktree
aparecia como arquivo não rastreado, a um `git add .` de ser commitado.

## O portão de pre-commit também roda em worktree

`git config core.hooksPath` aponta para `.husky/_`, um diretório **gerado** pelo script
`prepare` (husky) — e que `git worktree add` não cria. Até 21/08/2026 isso significava
que **um commit em worktree passava sem lint, sem typecheck e sem teste, em silêncio**;
foi assim que dois erros de prettier chegaram ao CI e derrubaram o check `zero-tolerance`
do PR #135.

Por isso `.husky/_/h` e `.husky/_/pre-commit` são **versionados de propósito** (o resto
de `.husky/_` segue ignorado): eles são o mínimo que o git precisa para encontrar o
portão real em `.husky/pre-commit` numa worktree que nunca rodou `pnpm install`.

O portão roda, nessa ordem: `lint-staged` → `pnpm run typecheck:strict` → `pnpm run test`.
Se ele não tiver como rodar (sem `pnpm`, sem `node_modules`), **ele barra o commit e diz
o que fazer** — nunca deixa passar calado. `scripts/ci/husky-worktree-gate.test.ts`
falha no CI se alguém tirar esses arquivos do controle de versão de novo.

Não use `|| true`, `continue-on-error` nem skip de teste para contornar o portão.

## Antes de empurrar, rode à mão

O pre-commit cobre o caminho normal, mas confirme os três antes de abrir PR:

```bash
npx eslint . --max-warnings 0
pnpm --filter @gitorch/control-plane build     # portão real de tipos do control-plane
cd apps/control-plane && npx vitest run
```
