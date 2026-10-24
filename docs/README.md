# GitOrch Docs

Este diretorio e o mapa oficial da documentacao do GitOrch. A regra simples: se um documento vive aqui, ele precisa ter uma finalidade clara, ficar na pasta certa e estar linkado por este indice ou pelo README principal do projeto.

## Como ler

Todo link abaixo aponta para um arquivo que existe neste repositorio. O
teste `scripts/ci/docs-index.test.ts` falha no CI se algum deixar de existir.

Para entender o produto:

1. [Product: Painel do owner](./product/painel-owner.md)
2. [Plano: GitOrch cuidando do repositorio inteiro (2026-09-15)](./superpowers/plans/2026-09-15-gitorch-repositorio-inteiro.md)

Para entender como os agentes se comportam:

1. [Agents: Contrato de comportamento (lifecycle)](./agents/agent-lifecycle-contract.md)
2. [Agents: Dependencia real entre tasks (D74)](./agents/dependencia-real-entre-tasks.md)
3. [Agents: Async Dev Agents (Jules)](./agents/async-dev-agents.md)
4. [Agents: Scrum Master](./agents/scrum-master.md)
5. [Agents: Research Analyst](./agents/research-analyst.md)
6. [Agents: Quality Assurance](./agents/quality-assurance.md)

Para operar:

1. [Operations: CI/CD Pipeline](./operations/ci-cd.md)
2. [Operations: Como o seu projeto avisa que a versao subiu](./operations/como-seu-projeto-avisa-que-subiu.md)
3. [Operations: Inventario de avisos (Telegram vs. painel)](./operations/inventario-avisos-telegram-vs-painel.md)

Para entender historico de implementacao:

1. [Implementation: Fase 2, motores do cliente (multi-tenant)](./implementation/f2-client-engines.md)
2. [Superpowers Plan: F3 Graph RAG Pipeline](./superpowers/plans/2026-06-19-f3-graph-rag-pipeline-implementation-plan.md)
3. [Superpowers Plan: Workspace Engine (2026-06-25)](./superpowers/plans/2026-06-25-workspace-engine.md)
4. [Superpowers Plan: F7 Workspace Engine (2026-06-26)](./superpowers/plans/2026-06-26-f7-workspace-engine-implementation-plan.md)

Release notes:

1. [Release Notes: F3 Graph RAG Pipeline](./superpowers/release-notes/2026-06-20-f3-graph-rag-pipeline.md)
2. [Release Notes: F4 Synapse + Pheromones](./superpowers/release-notes/2026-06-22-f4-synapse-pheromones.md) — [Package README: Synapse](../packages/synapse/README.md)
3. [Release Notes: F6 Agents Runtime Orchestration](./superpowers/release-notes/2026-06-24-f6-agents-runtime-orchestration.md)
4. [Release Notes: F7 Workspace Engine](./superpowers/release-notes/2026-06-26-f7-workspace-engine.md)
5. [Document Release: F8 Control Plane API](./document-release/RELEASE-F8.md)

## Estrutura

| Pasta | Uso |
|---|---|
| `product/` | Documentos de produto: problema, escopo, telas. |
| `agents/` | Contrato de comportamento dos agentes (SM, RA, QA, async dev) e regras entre tasks. |
| `operations/` | Runbooks e processos operacionais: CI/CD, publicacao, avisos. |
| `implementation/` | Planos tecnicos de features especificas, com contexto e decisoes. |
| `superpowers/plans/` | Planos de implementacao por fase, com data e status. |
| `superpowers/release-notes/` | Release notes por fase. |
| `document-release/` | Release notes consolidadas de fase. |

Pastas previstas pela tabela de tipos abaixo e que ainda nao tem documento
(`architecture/`, `setup/`, `reference/`, `roadmap/`, `research/`) podem ser
criadas quando o primeiro documento delas nascer.

## Como documentar

Antes de criar um documento novo, escolha o tipo:

| Tipo | Pergunta que responde | Pasta |
|---|---|---|
| Tutorial/setup | "Como eu configuro ou rodo isso?" | `setup/` |
| How-to operacional | "Como eu opero esse fluxo?" | `operations/` |
| Referencia | "Qual e o contrato/API/campo/opcao?" | `reference/` |
| Arquitetura | "Como isso funciona por dentro?" | `architecture/` |
| Produto | "Por que isso existe e qual escopo?" | `product/` |
| Agente | "Como este agente decide e age?" | `agents/` |
| Roadmap/status | "O que esta pronto e o que falta?" | `roadmap/` |
| Plano de feature | "Como esta feature sera/foi implementada?" | `implementation/` |

## Regras

1. Nao criar arquivos soltos em `docs/`.
2. Nao criar mega-documentos que concatenam outras docs.
3. Nao duplicar a fonte da verdade: se um documento novo substitui outro, remova o antigo ou marque claramente o antigo como historico dentro de `implementation/`.
4. Toda doc nova deve ser linkada neste `docs/README.md`.
5. Planos tecnicos devem ter `Status`, data e escopo.
6. Docs operacionais devem dizer quem executa, quando executa e qual evidencia prova que terminou.
7. Se uma doc mencionar caminho local, usar o caminho da raiz do checkout no host (ex.: a saida de `git rev-parse --show-toplevel`), nunca um caminho absoluto de uma maquina especifica.

## Documentos removidos nesta organizacao

- `docs/plans/PLAN-main.md`: removido por ser um agregado redundante de BRD, MVP, PBL, PMF, agentes, status e procedimento.
- `docs/planning/Prompt.md`: removido por ser briefing bruto e conter caminhos antigos. O conteudo valido foi absorvido pelos documentos de produto e operacao.
- `docs/plans/PLAN-telegram-notifications.md`: removido por ter sido substituido por `implementation/telegram-agent-notifications.md` (que nao esta versionado neste repositorio).
- `docs/github-projects-v2.md` e `docs/planning/GITHUB_PROJECTS_V2.md`: consolidados em `operations/github-projects-v2.md` (que nao esta versionado neste repositorio).
