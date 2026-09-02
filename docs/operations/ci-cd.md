# CI/CD Pipeline

**Status:** Operação atual — CI principal do GitOrch  
**Workflow atual:** `.github/workflows/ci.yml`  
**Fonte oficial relacionada:** `docs/superpowers/plans/2026-06-20-ci-zero-tolerance-implementation-plan.md`

## Estado atual

O CI atual é o workflow `.github/workflows/ci.yml`.

Ele roda em:

- push para `main`;
- push para `develop`;
- pull requests para `main`;
- pull requests para `develop`.

## Políticas de Tolerância Zero

Nossa esteira de CI (`main`) obedece a políticas inegociáveis de tolerância zero:
1. **100% de Cobertura de Testes**: Nenhuma linha de código, declaração ou branch (`if/else`) pode subir sem testes cobrindo-a (Vitest thresholds em 100%).
2. **Zero Avisos (Warnings) e Tipos Fracos**: 
   - A flag `--max-warnings 0` derruba qualquer lint imperfeito.
   - A regra `no-warning-comments` está configurada como erro, impedindo a submissão de dívidas técnicas ou código incompleto com `// TODO` ou `// FIXME`.
   - O TypeScript é checado estritamente, com a regra `no-explicit-any` proibindo o tipo genérico `any`.
3. **Validação de Banco de Dados**: As migrações do Prisma são geradas/validadas em tempo de build para evitar gargalos em produção.
4. **Timeout Rápido**: O CI falha instantaneamente se demorar mais que **30 minutos**.

## Husky e Pre-commit (Local)

Para garantir que o código quebrado nem sequer inicie o fluxo do CI, utilizamos o **Husky** com `lint-staged` integrado no hook de `pre-commit`:
- O `lint-staged` roda o lint estrito (com max-warnings 0) apenas nos arquivos commitados.
- O `typecheck:strict` audita toda a base para tipagens incorretas.
- Os testes (`vitest`) rodam garantindo a manutenção da cobertura de 100% através de testes que usam cache do Turborepo para rodar com performance.

Qualquer violação aborta o commit *localmente*.

## Serviço usado

O workflow sobe **PostgreSQL 16** como service container:

```yaml
postgres:16
```

Não há Redis no CI atual.

## Passos executados (job `zero-tolerance`)

O `ci.yml` tem três trabalhos: `zero-tolerance` (a tabela abaixo), `e2e-funil-fake` (o funil do setup wizard navegado no navegador em todo PR) e `scripts-de-automacao` (descrito adiante).

| Ordem | Etapa | Comando / ação |
|---:|---|---|
| 1 | Checkout | `actions/checkout@v7` com `fetch-depth: 0` |
| 2 | Setup pnpm | `.github/actions/setup-pnpm` |
| 3 | Install | `pnpm install --frozen-lockfile` |
| 4 | CI baseline | `pnpm exec tsx scripts/ci/verify-ci-baseline.ts` |
| 5 | Typecheck | `pnpm run typecheck:strict` |
| 6 | Lint | `pnpm run lint:ci` |
| 7 | CGC audit | `pnpm run audit:cgc` |
| 8 | README/code parity | `pnpm run audit:readme-parity` |
| 9 | Impact radius | `pnpm exec tsx scripts/ci/impact-radius.ts "$changed"` |
| 10 | Testes impactados | `pnpm run test` ou `pnpm exec turbo run test ...` |
| 11 | Secret scan | `gitleaks/gitleaks-action@v2` |
| 12 | Pheromone marker | `pnpm run audit:secrets` |
| 13 | Playwright E2E | `pnpm run e2e` |
| 14 | Audit summary | `pnpm exec tsx scripts/ci/audit-summary.ts` |
| 15 | Upload CI audit | `.github/actions/upload-ci-audit` |

## Testes dos scripts de automação

Os scripts que governam as automações do repositório vivem em `.github/scripts`, que fica **fora dos workspaces do pnpm**. Nenhum job alcançava esse diretório, então os testes que existiam ali nunca rodaram em PR nenhum.

O job `scripts-de-automacao` fecha isso: instala pelo lockfile do próprio diretório, roda o typecheck e a suíte. Não depende de banco nem de navegador — leva segundos.

```bash
cd .github/scripts && npm ci && npm run typecheck && npm test
```

Em 02/09/2026, por decisão do dono (D62, o GitOrch é a única esteira), saíram os 6 workflows que acionavam o Jules por fora do produto (`code-scanning-to-jules`, `dependabot-to-jules`, `jules-apology-handler`, `jules-auto-recovery`, `jules-pr-ci-failure`, `jules-pr-conflict`) e os scripts e libs que só serviam a eles. Ficaram `sla-tracker.ts`/`sla-tracker.yml` e `lib/pr-eligibility.ts` (lido por `vigia-do-pr.test.ts`). Detalhes em `.github/DEPENDABOT-JULES-AUTOMATION.md`.

## Merge automático e o portão do QA

O `.github/workflows/auto-merge.yml` mescla sozinho **apenas** pull requests da automação de segurança: os do Dependabot e os do dev assíncrono que resolvem uma issue com label `dependabot`/`jules`. Qualquer outro pull request não entra por essa via.

**São dois porteiros, não um.** O CI diz se o código roda; o QA diz se o código resolve o que a issue pediu. A regra vive em `.github/scripts/lib/merge-gate.ts`, separada do workflow justamente para poder ser testada:

| Situação | Decisão |
|---|---|
| Código do dev assíncrono sem veredito do QA | segura, e diz que aguarda o julgamento |
| QA reprovou | segura, e diz o que destrava |
| QA aprovou **outra versão** e o topo mudou desde então | segura — aprovação vale para a versão julgada, não para o pull request |
| Aprovação do QA foi **descartada** | segura — descarte revoga, e não deixa um julgamento anterior no lugar |
| Aprovação vinda de conta homônima **sem o sufixo de robô** | segura — não é o QA |
| QA aprovou a versão atual | libera |
| Rotina de dependência (todos os commits do topo são do robô) | libera (não espera veredito que nunca vem) |
| Falha ao consultar o veredito | segura — na dúvida, não mescla |

Cinco detalhes que parecem preciosismo e não são:

1. **O veredito é reconferido segundos antes de mesclar**, não só no início. Entre a primeira consulta e a mesclagem existe a espera pelo CI, que dura minutos — e é exatamente nela que o dev assíncrono envia correção quando o CI fica vermelho. Sem reconferir, a aprovação de um commit liberaria outro.
2. **A mesclagem se prende à versão reconferida.** Ela exige da plataforma que o topo seja exatamente o commit julgado e recusa se tiver mudado; sem isso, o intervalo entre reconferir e mesclar continuaria aberto.
3. **O login do revisor é comparado inteiro, com o sufixo `[bot]`.** O QA é um App e revisa como `nome[bot]`; o login `nome`, sem o sufixo, é uma conta de pessoa que qualquer um pode registrar — e num repositório público qualquer pessoa pode aprovar um pull request. Colchete não é caractere válido em nome de usuário, então o sufixo é justamente o que não dá para falsificar.
4. **O sistema não julga a si mesmo.** A automação aprova em nome da plataforma antes de mesclar; essa aprovação nunca conta como julgamento, mesmo que o revisor de qualidade seja configurado com a identidade dela.
5. **O gatilho `pull_request_review` é necessário para o laço fechar.** O veredito chega como revisão, e revisão não dispara nenhum dos outros eventos — sem ele o pull request aprovado esperaria para sempre.

Dispensar o julgamento é decisão sobre o **código do topo**, não sobre quem abriu o pull request: quem abriu continua sendo o robô de dependências mesmo depois que outra pessoa empurra um commit no mesmo ramo. Por isso a pergunta é feita sobre a autoria de cada commit.

Quem é o revisor de qualidade sai da variável de repositório `GITORCH_QA_REVIEWER`. Quando ela não existe, vale o App do produto com o sufixo de robô — a identidade que não é registrável por terceiros.

## Scripts relevantes

```json
{
  "typecheck:strict": "pnpm exec tsx scripts/ci/run-typecheck-strict.ts",
  "lint:ci": "eslint . --max-warnings 0",
  "audit:cgc": "pnpm exec tsx scripts/ci/run-cgc-audit.ts",
  "audit:readme-parity": "pnpm exec tsx scripts/ci/readme-code-parity.ts",
  "audit:secrets": "pnpm exec tsx scripts/ci/secret-scan.ts",
  "e2e": "pnpm exec tsx scripts/ci/e2e-playwright.ts"
}
```

## O que não existe mais no CI atual

Este documento não deve mencionar como etapa atual:

- Redis service;
- BullMQ;
- `pnpm db:generate`;
- `packages/agents`;
- QA Gate workflow;
- endpoints `/api/qa-gate/*`;
- `GITORCH_API_URL` / `GITORCH_API_KEY` para QA Gate.

Esses itens são roadmap ou documentação antiga.

## Reproduzir localmente

Mínimo recomendado:

```bash
pnpm install --frozen-lockfile
pnpm run typecheck:strict
pnpm run lint:ci
pnpm run audit:cgc
pnpm run audit:readme-parity
pnpm run e2e
pnpm run test
```

Para impact radius:

```bash
pnpm exec tsx scripts/ci/impact-radius.ts "$(git diff --name-only origin/main...HEAD)"
```

## Branch protection

Esta seção descreve o que está **efetivamente configurado** na plataforma, não o que seria desejável. Ao mudar a configuração, mude este texto junto — as duas coisas divergiram no passado, e uma proteção que só existe no documento não protege nada.

O que a `main` exige hoje:

| Regra | Estado | Efeito |
|---|---|---|
| Status checks obrigatórios | `zero-tolerance`, `infra-guard` | A plataforma recusa a mesclagem enquanto esses dois não estiverem verdes |
| Branch atualizada antes de mesclar (`strict`) | desligado | Evita a fila de rebase em cadeia quando vários PRs de dependência abrem juntos |
| Aprovação obrigatória de revisor | desligado | Ver a justificativa abaixo |
| Force-push | bloqueado | Ninguém reescreve o histórico da `main` |
| Exclusão da branch | bloqueada | — |
| Histórico linear | exigido | Merge commit direto na `main` é recusado; squash e rebase continuam valendo, e o merge automático já usa squash |
| Administradores incluídos (`enforce_admins`) | desligado | Quem tem admin no repositório continua passando por cima, de propósito: é a válvula de emergência para consertar a `main` quando o próprio CI está quebrado |

Os nomes na primeira linha são os **nomes dos checks** (`zero-tolerance` e `infra-guard`, os jobs), não os nomes dos workflows (`CI` e `Infra Guard`). Marcar um contexto que nunca é reportado deixa todo PR parado para sempre em "waiting for status to be reported" — por isso só entram aqui jobs que rodam em **todo** PR contra a `main`, sem filtro de `paths` e sem `if:` condicional.

Por que aprovação obrigatória de revisor está desligada: ela quebraria o merge automático de dependências. O `auto-merge.yml` aprova o PR com o token da automação antes de mesclar, e a configuração "Allow GitHub Actions to create and approve pull requests" está desligada no repositório e na organização — a aprovação da automação falha, e a falha está engolida por um `|| true` no workflow. Ligar a exigência sem antes resolver isso (habilitar aquela opção, ou dar à automação um token de pessoa via secret `SECURITY_PAT`) faria todo PR do Dependabot parar à espera de um clique manual.

A proteção é a rede de segurança **atrás** do `auto-merge.yml`, não um substituto dele: mesmo que o workflow tenha um defeito e tente mesclar cedo, a plataforma recusa enquanto o CI não estiver verde.

Falta cobrir: secret scan como check obrigatório separado (hoje ele é um passo dentro do `zero-tolerance`, então já bloqueia por tabela).

O portão do QA descrito acima **não substitui** a proteção de branch: ele governa apenas a via do merge automático, e a proteção continua valendo para todo o resto.
