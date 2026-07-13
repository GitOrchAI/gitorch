# GitOrch Docs

Este diretorio e o mapa oficial da documentacao do GitOrch. A regra simples: se um documento vive aqui, ele precisa ter uma finalidade clara, ficar na pasta certa e estar linkado por este indice ou pelo README principal do projeto.

## Como ler

Para entender o produto:

1. [Product: Business Requirements](./product/business-requirements.md)
2. [Product: MVP](./product/mvp.md)
3. [Product: Product Requirements](./product/product-requirements.md)
4. [Roadmap: Status](./roadmap/status.md)
5. [Document Release: Fase F0 à F1.2](./document-release/RELEASE-F0-F1.2.md)
6. [Document Release: Fase F1 CGC Core](./document-release/RELEASE-2026-06-19.md)
7. [Release Notes: F4 Synapse + Pheromones](./superpowers/release-notes/2026-06-22-f4-synapse-pheromones.md)
8. [Release Notes: F7 Workspace Engine](./superpowers/release-notes/2026-06-26-f7-workspace-engine.md)

Para entender a arquitetura:

1. [Architecture: Overview](./architecture/overview.md)
2. [Architecture: Cortex 4-Layer](./architecture/cortex-4layer-architecture.md)
3. [Reference: Runtimes](./reference/runtimes.md)
4. [Setup: Telegram](./setup/telegram.md), se for configurar notificacoes

Para operar o fluxo multi-agente:

1. [Operations: GitHub Projects V2](./operations/github-projects-v2.md)
2. [Agents: Async Dev Agents](./agents/async-dev-agents.md)
3. [Agents: Product Owner](./agents/product-owner.md)
4. [Agents: Scrum Master](./agents/scrum-master.md)
5. [Agents: Requirements Analyst](./agents/requirements-analyst.md)
6. [Agents: Quality Assurance](./agents/quality-assurance.md)
7. [Operations: Multi-Agent Flow](./operations/multi-agent-flow.md)

Para entender historico de implementacao:

1. [Roadmap: Implementation Plan](./roadmap/implementation-plan.md)
2. [Implementation: Antigravity Runtime](./implementation/antigravity-runtime.md)
3. [Implementation: Telegram Agent Notifications](./implementation/telegram-agent-notifications.md)
4. [Implementation: QA gate por PR (autoplan, Blocos A-D)](./implementation/qa-gate-pipeline.md)
5. [Implementation: QA acionado quando o Jules termina (gatilho de 2 caminhos)](./implementation/qa-trigger-on-jules-done.md)
6. [Implementation: Setup Wizard e Bootstrap de Projeto](./implementation/setup-wizard-bootstrap-mvp.md)
7. [Implementation: F0 Foundation + F1 CGC Core & Indexer Summary](./implementation/F0-F1.4-summary.md)
8. [Implementation: Fase F2 Cortex 4-Layer](./implementation/f2-cortex-4layer.md)
9. [Superpowers Plan: F4 Synapse + Pheromones](./superpowers/plans/2026-06-22-f4-synapse-pheromones-implementation-plan.md)
10. [Superpowers Plan: F7 Workspace Engine](./superpowers/plans/2026-06-26-f7-workspace-engine-implementation-plan.md)

Para pesquisas e decisoes tecnicas:

1. [Research: Hermes Model Capability (multi-step curl)](./research/hermes-model-capability.md)
2. [Research: GitHub Projects V2 Gaps](./research/github-projects-v2-gaps.md)
3. [Research: Agent MCP Access](./research/agent-mcp-access.md)

Para features e endpoints (entregues recentemente):
 
1. [Reference: CLI `gitorch`](./reference/cli.md) - [Setup: `gitorch init`](./setup/cli-init.md)
2. [Reference: Telemetry](./reference/telemetry.md) - [Architecture: por que telemetria](./architecture/explanation-telemetry.md)
3. [Reference: Governance/Audit](./reference/governance-audit.md) - [Operations: inspecionar o audit feed](./operations/governance-audit.md)
4. [Reference: Runtimes](./reference/runtimes.md) - [Architecture: fallback de runtime + quota](./architecture/explanation-runtime-fallback.md) - [How-to: configurar cadeia de fallback](./reference/how-to-configure-runtime-fallback.md)
5. [Architecture: Mnemo — memória semântica dos agentes](./architecture/explanation-agent-memory.md) — [Implementation: deploy + rollout](./implementation/mnemo-memory.md) — [Reference: DDL + API TS](./reference/memory-mnemo.md)
6. [Reference: GitHub Auth (App + OAuth + PAT)](./reference/github-auth.md) - [Setup: GitHub App](./setup/github-app.md)
7. [Architecture: Code Graph Context (CGC)](./architecture/cgc-architecture.md) — [Setup: Primeiros passos (CGC)](./setup/quickstart-cgc.md) — [Reference: CGC API](./reference/cgc-api.md) — [How-to: Indexar e Consultar Grafo](./development/howto-index-file.md)
8. [Architecture: Cortex 4-Layer](./architecture/cortex-4layer-architecture.md) — [Reference: CortexClient API](./reference/cortex-client-api.md) — [Implementation: F2 Cortex](./implementation/f2-cortex-4layer.md)
9. [Release Notes: F4 Synapse + Pheromones](./superpowers/release-notes/2026-06-22-f4-synapse-pheromones.md) — [Package README: Synapse](../packages/synapse/README.md)

Para post-mortems e incidentes:

1. [Operations: Antigravity PTY Fix (2026-06-01)](./operations/antigravity-pty-fix-2026-06-01.md) — root cause do hang de 14min, fix via PTY, 4 providers verificados
2. [Operations: Agent Runtime Recovery (2026-06-11)](./operations/agent-runtime-recovery-2026-06-11.md) — estado real do produto, diagnostico dos agentes e ordem recomendada para religar backend, memoria, agentes e runtimes

## Estrutura

| Pasta | Uso |
|---|---|
| `product/` | Documentos de produto: problema, escopo, MVP, backlog e mercado. |
| `architecture/` | Como o sistema funciona tecnicamente. Deve explicar estado atual, nao planos soltos. |
| `agents/` | Contrato de comportamento dos agentes PO, SM, RA, QA e async dev. |
| `operations/` | Runbooks e processos operacionais: Projects V2, fluxo multi-agente, governanca. |
| `setup/` | Tutoriais de configuracao local ou de integracoes. |
| `reference/` | Referencias tecnicas estaveis, como runtimes, endpoints ou schemas. |
| `roadmap/` | Estado atual, fases e proximas entregas. |
| `implementation/` | Planos tecnicos de features especificas, com contexto e decisoes. |
| `research/` | Pesquisas e validacoes tecnicas com data, metodo, resultados e decisao. |

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
- `docs/plans/PLAN-telegram-notifications.md`: removido por ter sido substituido por [Implementation: Telegram Agent Notifications](./implementation/telegram-agent-notifications.md).
- `docs/github-projects-v2.md` e `docs/planning/GITHUB_PROJECTS_V2.md`: consolidados em [Operations: GitHub Projects V2](./operations/github-projects-v2.md).
