# AGENTS.md — GitOrch

Guia de contexto do repositório para agentes de codificação (Jules e outros). Este arquivo
descreve **apenas o que existe de verdade neste repositório** — comandos reais, estrutura real,
portão de qualidade real. Nenhuma ferramenta ou script externo é assumido.

## O que é este projeto

**GitOrch** é um control plane de orquestração multi-agente para workflows de engenharia sobre
repositórios GitHub. Monorepo gerenciado com **pnpm workspaces** + **Turborepo**.

- `apps/control-plane` — backend Fastify + Prisma (Postgres), API principal
- `apps/web` — frontend Next.js
- `apps/landing` — landing page
- `packages/*` — bibliotecas internas (agents, cgc, cortex, github-sync, graph-rag, synapse,
  workspace-engine)
- `.github/scripts` — automação de segurança (Dependabot/CodeQL → Jules → auto-merge)

## Comandos reais (rode estes, não invente outros)

```bash
pnpm install --frozen-lockfile   # instalar dependências (sempre frozen; --no-frozen-lockfile
                                  # só se o proprio lockfile precisar ser regenerado de proposito)
pnpm run build                   # build de todos os pacotes (turbo run build)
pnpm run test                    # testes de todos os pacotes (turbo run test)
pnpm run lint                    # lint de todos os pacotes (turbo run lint)
pnpm run lint:ci                 # lint estrito, 0 warnings tolerados (usado no CI)
pnpm run typecheck:strict        # typecheck estrito de todo o monorepo (usado no CI)
```

Dentro de `apps/control-plane` especificamente:
```bash
pnpm --filter @gitorch/control-plane run typecheck   # tsc --noEmit
pnpm --filter @gitorch/control-plane run lint         # eslint src
pnpm --filter @gitorch/control-plane run test          # vitest run
pnpm --filter @gitorch/control-plane run prisma:generate
```

## O portão de qualidade (CI) — tolerância zero

O job `zero-tolerance` (`.github/workflows/ci.yml`) roda em todo push/PR e é o único critério
que decide merge: **0 erros de TypeScript, 0 warnings de lint, testes passando, secret scan
limpo, build passando.** Não existe exceção nem `continue-on-error`. Se o CI está vermelho, o
problema é real — rode `pnpm run typecheck:strict` e `pnpm run lint:ci` localmente para
reproduzir antes de tentar corrigir.

### O portão local (pre-commit)

`.husky/pre-commit` roda `lint-staged` → `typecheck:strict` → `test` antes de cada commit.
Ele funciona igual no checkout principal e em worktree: `.husky/_/h` e `.husky/_/pre-commit`
são versionados de propósito, porque `git worktree add` não gera esse diretório e sem eles o
commit passava sem verificação nenhuma, em silêncio. Se o portão não tiver como rodar (sem
`pnpm`, sem `node_modules`), ele **barra o commit** e explica o que fazer. Detalhes e o passo
de ligar `node_modules` numa worktree nova estão em [`CLAUDE.md`](./CLAUDE.md).

## Convenção de commits e PRs

Mensagens de commit no padrão `tipo: descrição` (`fix:`, `feat:`, `security:`, `chore:`).
Título e descrição do PR em português (PT-BR) sempre que possível — é a língua de trabalho
deste projeto e do time que revisa.

## Sobre a automação de segurança (contexto, não uma instrução para executar)

Este repositório tem um pipeline automático: alerta do Dependabot/CodeQL → issue com prompt
detalhado (label `jules`) → você resolve → se o PR tiver conflito de merge ou CI vermelho, um
robô comenta `@jules` com a análise específica do problema → quando o CI fica 100% verde, o
merge acontece automaticamente. Você não precisa fazer nada especial para isso funcionar — só
resolver o problema descrito na issue/comentário da forma mais direta possível.

## Notas por app

- **`apps/web`**: veja `apps/web/AGENTS.md` — usa uma versão do Next.js com mudanças que
  quebram convenções conhecidas; leia a documentação em `node_modules/next/dist/docs/` antes
  de escrever código lá.
- **`apps/control-plane`**: Fastify + Prisma + Postgres. Migrations em
  `apps/control-plane/prisma/migrations/`. Rode `prisma:generate` depois de qualquer mudança
  de schema.
