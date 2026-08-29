# Painel do owner

O `/painel` do app web (`apps/web/src/app/painel/page.tsx`) é o **painel do owner** —
para quem é dono do projeto, não desenvolvedor. Porte do handoff
`GitOrch Design System` (kit `ui_kits/painel-owner`).

Vive na camada visual `.gl` (verde corporativo, off-white), com tema escuro no
botão da barra de topo, guardado em `localStorage` (`gitorch-painel-tema`, via
`useSyncExternalStore` sobre `components/painel/painel-tema.ts`). **Nunca** usa o
glass violeta/ciano do painel antigo do cliente.

## As 9 telas

| Tela | O que resolve | Fonte de dados (leva 1) |
|---|---|---|
| **Visão geral** | ritmo/sprint, pulso, 4 números, quem trabalha agora, pedidos, decisões pendentes | Pulso e "quem trabalha" **ao vivo**; KPIs de missão **ao vivo** (`/api/missions`); ritmo e prévia de pedidos = **exemplo + selo** |
| **Pedidos** | escrever um pedido em português (onde + urgência) e acompanhar | composer + seletor de projeto **ao vivo** (`/api/v1/desejos*`); lista = **exemplo + selo** (não há rota para listar desejos) |
| **Decisões** | lista + detalhe; responder por botão ou texto livre | lista **ao vivo** (`/api/v1/setup/agent-questions`, reusa `components/painel/agent-questions.ts`); responder **ao vivo** (rota nova) |
| **Entregas** | histórico pelo ganho, não pelo código | **exemplo + selo** (rota `/api/v1/painel/entregas` = leva 2) |
| **Custos e limites** | cota de cada motor, esforço por projeto, plano | cota dos motores **ao vivo best-effort**; KPIs/esforço/plano = **exemplo + selo** |
| **Projetos** | um cartão por repositório | **ao vivo** (`/api/projects`); saúde e "agentes ligados" ficam de fora (a rota não entrega — nunca inventado) |
| **Regras** | governança com interruptores | **visual**: interruptores locais, 2 obrigatórias travadas; backend = leva 2 |
| **Histórico** | registro imutável de quem fez o quê | **exemplo + selo** (rota `/api/v1/painel/historico` = leva 2) |
| **Configurações** | conta, sócios, avisos, tema, idioma, motores | **visual**; só o tema liga de verdade |

O selo `dado de exemplo` some sozinho quando `NEXT_PUBLIC_PAINEL_LEVA2=1` (aí as
telas de ritmo/entregas/histórico passam a bater na rota real).

## Regra de honestidade

Valor que pode faltar renderiza `—`, nunca `0`. Três estados distintos com três
frases (`carregando` / `indisponível` + botão / `vazio`), decididos em
`components/painel/painel-estados.ts` (testado). Nenhuma tela escreve a frase na
mão.

## Rotas novas — `apps/control-plane/src/routes/painel.ts`

Escopo por **dono** (`lib/resolve-owner-id.ts` — mesma regra de `routes/setup.ts`,
extraída para fonte única). Rate limit 60/min (polling) / 20/min (responder).
Nenhuma resposta carrega `userId`, `dedupKey`, `telegramMessageId` nem `projectId`.

| Rota | Devolve |
|---|---|
| `GET /api/v1/painel/pulso` | último `Event`/`Mission` de qualquer projeto do dono, com a hora **real** do evento (`ha_segundos`), a descrição em PT-BR (`services/descrever-evento.ts`) e `quente = ha_segundos < 3600`. Sem sinal → campos nulos. **Corrige** o bug de `/api/projects/:id/status`, que devolvia `lastActivity = new Date()` (a hora da consulta). O painel re-consulta a cada 20s. |
| `GET /api/v1/painel/agentes` | `atuando`: missões `running`/`pending` do dono (`progresso` sempre `null` nesta leva — barra estimada é pior que nenhuma). `motores`: best-effort; sem store de consumo persistida, devolve `[]` e a tela degrada com honestidade (nunca inventa `usado`). |
| `POST /api/v1/painel/decisoes/:id/responder` | `{ resposta }` → grava via `AgentQuestionService.answer(id, valor, 'panel')` — **a mesma função que o Telegram chama** (`services/telegram-bot.ts`). É a paridade painel↔Telegram: `answer()` aplica a configuração do projeto, grava no Cortex e é idempotente. `401` / `400` (vazia) / `404` (inexistente **ou** de outra conta — mesma frase, anti-vazamento) / `409` (já respondida — devolve a resposta que existe) / `200`. O painel **envia o `value` da opção**, nunca o label. |

## Deploy

`next build` (`output: 'export'`) → `apps/web/out/`. O control-plane serve
`/painel` a partir de `out/painel.html` **pela mesma origem da API** (Funnel),
via `plugins/web-static.ts`. Também publicado no GitHub Pages (`pages.yml`).

Sem migração de schema nesta leva.

## Leva 2 (PR separado)

- Faixa "sprint atual" no topo (rodar `/plan-ceo-review` + `/design-consultation` antes).
- `GET /api/v1/painel/ritmo` — decidir onde a meta/sprint mora (proposta: iteração do Projects V2).
- `GET /api/v1/painel/entregas` — origem do `ganho` (RA escreve / 1ª frase da issue / omite; **nunca** gerar com modelo em tempo de leitura).
- `GET /api/v1/painel/historico` — listar `Event` paginado, imutável.
- Cota de motor persistida (hoje best-effort), ações reais de Regras/Configurações, i18n do `/painel`.
