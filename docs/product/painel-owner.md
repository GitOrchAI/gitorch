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
| `GET /api/v1/painel/dev-cota` | Pedido do dono (01/09/2026): "precisa saber o que está sendo enviado, quando foi enviado" — a cota do dev assíncrono (Jules), POR CONTA (`devAccountId`, nunca por projeto — o teto real é da conta). Por conta: `tetoConcorrentes`/`tetoDiario` do plano declarado (o mais restritivo, se os projetos da conta divergirem), `simultaneas`/`vagasRestantes` (janela de vaga simultânea), `enviadas24h`/`vagasDiariasRestantes` (JANELA ROLANTE de 24h, não dia de calendário) e `sessoes24h` (o que foi enviado e quando, mais recente primeiro). Função pura em `services/resumo-de-cota-do-dev.ts`. **Sem tela própria ainda** — o dado existe na API; a tela é leva futura. |
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

## Entregas: a unidade é o PEDIDO, e a lista casa com o número (31/08)

**Os defeitos, medidos no banco do dono.**

```
select count(*), count(distinct issue_number) from dev_sessions;   -- 200 | 99
-- 15 pedidos passam na régua padrão (gitorch 1 de 58, patinhas 14 de 41)
```

1. **O teto escondia as entregas.** `GET /api/v1/painel/entregas` trazia as 50
   sessões mais recentes e reavaliava a régua em memória. Das 15 entregas
   prontas, **nenhuma** cabia nessas 50: elas ocupam as posições 66 a 193 na
   ordem por `updated_at`. A tela dizia `PRONTAS: 0` com quinze no ar.
2. **O denominador contava a coisa errada.** O cartão diz "Pedido #N" e a nota
   dizia "de 200 que passaram pela sua régua" — 200 é o número de SESSÕES. O
   dono lia duzentos pedidos onde há noventa e nove.
3. **A lista contradizia o cabeçalho.** O cabeçalho anunciava "Prontas: 15" e a
   lista mostrava as 50 sessões mais recentes, onde há ZERO prontas.
4. **Cartões acumulavam ao virar a página.** A `key` do `<Card>` era
   `${projeto}-${pedido}`, e `pedido` não é único quando a linha é uma sessão.
   Contando as colisões por página de 25: página 1 tinha 8, página 2 tinha 4. O
   React monta o mapa de reconciliação por key, o segundo fiber sobrescreve o
   primeiro, e o fiber sombreado não é reaproveitado nem apagado — o nó de DOM
   dele fica na tela. Daí a aritmética que o QA contou no navegador:
   25 → 25+8 = **33** → 33+4 = **37**.

**A correção, com uma raiz só para 2, 3 e 4: a rota passou a responder em
PEDIDOS.** `services/entregas-por-pedido.ts` agrupa as sessões por
`(projeto, pedido)`, julga cada pedido pela régua do projeto dele e devolve
`{ entregas, prontas, andando, total, grupo, pagina, porPagina, paginas }`.
`prontas`, `andando` e `total` falam da população inteira; `entregas` é só a
página do grupo pedido.

**Um pedido está pronto se ALGUMA sessão dele passou na régua** — não se a
última passou. Os critérios são fatos que não se desfazem: um PR foi mesclado,
uma publicação chegou ao ar. Uma sessão posterior no mesmo pedido é trabalho a
mais sobre algo que já chegou às mãos do dono, e não desmescla nem despublica o
que já está lá. Julgar pela última faria uma entrega em produção sumir da conta
no instante em que alguém abrisse um retoque sobre ela. `prontoEm` é o instante
mais antigo em que o pedido passou — "ficou pronto" é quando chegou lá pela
primeira vez.

**A aba lista ENTREGAS.** O grupo padrão é o das prontas, ordenado da mais
recente para a mais antiga. O que não fechou está no grupo "Ainda não
fecharam", com a contagem no próprio botão e o que a lista mostra escrito em
palavras abaixo dele — filtro que o dono não vê é a mesma família de mentira que
esta tela veio acabar.

**A fonte continua sendo `dev_sessions`, e não `increments`.**

- `increments` **é escrita** — `scheduler.ts` grava quando a publicação muda de
  estado. Mas grava só **para a frente**: em 31/08 a tabela tem **0 linhas**.
  Ler dali hoje faria a tela dizer "0 prontas". **O leitor vem antes do
  backfill, nunca o contrário.**
- **O backfill não resolve, porque a data mentiria.** `Increment.prontoEm` é
  `default(now())` e nada guarda o instante em que o último critério passou. Um
  backfill hoje carimbaria 31/08 em entregas que foram ao ar dia 27.
- **São perguntas diferentes.** `increments` congela a régua que valia na hora
  (é história). Esta tela responde "o que está pronto pela minha régua de HOJE".

**Uma régua, uma implementação.** A contagem é feita em TypeScript com
`avaliarPronto`, e não traduzida para um `where` de banco. Ao nível da sessão a
tradução funcionava; ao nível do PEDIDO o veredito é um agregado com data
derivada por grupo e por régua de projeto, e escrevê-lo em SQL seria uma segunda
implementação da régua com uma superfície de divergência bem maior — divergência
que apareceria como número errado na tela, sem erro nenhum no caminho.

**O preço, medido e declarado.** A rota lê as sessões do dono inteiras: 200
linhas de 7 colunas hoje. Quando isso passar a custar, o conserto é agregar por
pedido no banco (`groupBy`) — **nunca** um `take` que corta a população.

**Ordenação estável.** A consulta ordena por `[updatedAt desc, id desc]` e a
ordem final desempata por projeto e número do pedido. `updated_at` é reescrito
pela esteira o tempo todo; ordenar só por ele deixa linhas empatadas trocando de
lugar entre uma virada de página e a seguinte.

**Rodada de agente nunca é entrega.** A Visão Geral lia `missions.completed`
(4.521 em 31/08) sob o rótulo "Entregue no total", enquanto a aba ao lado dizia
"PRONTAS: 0" — duas fontes respondendo a mesma pergunta. Os KPIs agora leem a
MESMA rota da aba Entregas, e os contadores de `missions` ficaram com o nome do
que são ("Rodadas de agente"). `painel-numeros.ts` tem um teste que cobra a
regra: nenhum número de fonte `rodadas` pode usar palavra de entrega no rótulo
ou na nota.

**Fechar issue não é entregar.** `arvore-de-pedidos.ts` marcava
`situacao: 'entregue'` só porque a issue estava `CLOSED`. Uma issue fecha por
muitos motivos, e nenhum deles passa pela régua. O estado agora se chama
`'fechado'` e a tela diz "Fechado".
