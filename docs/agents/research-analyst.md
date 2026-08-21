# GitOrch – RA Agent (Research Analyst)

**Status:** ATUAL — runtime real em `apps/control-plane/src/services/role-rails.ts` (`runRaRails`)
e `packages/cadence/src/rails.ts` (schemas/formatação), agendado por
`apps/control-plane/src/lib/project-defaults.ts`.
**Correção 21/08/2026:** esta versão substitui a anterior, que descrevia um RA que decompunha
desejo em Features/Tasks com prazo declarado e barra de progresso — **isso nunca existiu no
código**. Decisão do dono (D29): *"código tá certo"*; o documento é que tinha envelhecido.
Ver `docs/agents/product-owner.md` para quem realmente faz essa decomposição.

## 1. O desenho: DUAS VOZES

Nas palavras do dono (21/08/2026): *"RA usa skills do gstack de planejamento (dual vozes, etc.) pra
seguir padrão de pessoa que não sabe codar e pede algo, e depois o padrão de desenvolvedor pega essa
informação do que não sabe codar e planeja em cima do que está colocado na visão do sem conhecimento,
junto com nosso codegraph, e então vai montando tudo na memória pra que o RA trabalhe."*

Em termos concretos:

- **1ª voz — o leigo.** O owner do projeto (que não sabe codar) escreve o pedido em português comum,
  como uma issue de desejo/wishlist no GitHub. Não precisa citar tecnologia, arquitetura ou o nome de
  nenhuma integração — só o que ele quer que aconteça.
- **2ª voz — o padrão de desenvolvedor.** O RA pega esse pedido cru e planeja em cima dele **junto com
  o codegraph** (o mapa do código, hoje gerado pelo graphify/CGC) — nunca inventa: toda âncora de
  jornada tem que ser um arquivo real, verbatim do contexto de código montado para a missão.
- **O resultado vira memória**, e é dela que o RA (e depois o PO) trabalha dali em diante.

Isso está construído em `runRaRails` (`apps/control-plane/src/services/role-rails.ts:34-78`): um
roteiro de **3 passos encadeados**, cada um preenchendo um formulário validado por schema
(`packages/cadence/src/rails.ts`). Nenhum passo age no GitHub — o executor do control-plane que
aplica o resultado.

| Passo | Schema | O que produz |
|---|---|---|
| 1. Áreas | `RAILS_SCHEMAS.raAreas` | Para cada área do sistema tocada (frontend, backend, banco, integrações, infra…): o que existe hoje, o que o desejo precisa ali, e os arquivos reais a ler (`role-rails.ts:38-49`) |
| 2. Jornadas | `RAILS_SCHEMAS.raJourneys` | **No mínimo 2 jornadas completas**, cada uma **no mínimo 3 passos**, cada passo com `detalhes[]` e uma `ancora` (arquivo/módulo real) — forçado pelo schema, não por instrução de prompt (`packages/cadence/src/rails.ts:268-297`) |
| 3. Brief | `RAILS_SCHEMAS.raBrief` | O que o projeto é, arquitetura/stack, top riscos, oportunidades de melhoria, perguntas abertas para o PO (`role-rails.ts:65-74`) |

A profundidade é **forçada por schema**, não é estilo de prompt: uma resposta com 1 jornada ou uma
jornada com 2 passos é rejeitada antes de chegar a qualquer lugar
(`packages/cadence/src/rails.ts:274` — `minItems: 2` em `journeys`; linha `285` — `minItems: 3` em
`steps`; linha `288` — `passo`, `detalhes` e `ancora` são todos obrigatórios).

A formatação final numera as jornadas em dois níveis (`I.K` para o passo, `I.K.N` para cada detalhe
dentro dele) em `formatRaJourneys` (`packages/cadence/src/rails.ts:96-104`) — é o rigor da 2ª voz, e é
esse texto formatado que vira o contexto de memória que o PO lê (`formatRaDeliverable`,
`packages/cadence/src/rails.ts:113-130`).

**O que o RA NÃO faz:** decompor em Épico/Feature/Task, atribuir prazo (curto/médio/longo) ao desejo,
ou manter barra de progresso por desejo. Essa decomposição em fase›épico›feature›tarefa é do **PO**,
em `runPoRails` (`apps/control-plane/src/services/role-rails.ts:107-201`), um roteiro separado de
**5 passos** (fases → épicos → features → tasks → roadmap) que usa as jornadas do RA como cobertura
obrigatória: todo épico precisa referenciar ao menos uma jornada
(`apps/control-plane/src/services/po-rails-mission.ts:51-55`, `countJourneysInContext` — o executor
rejeita plano que ignora uma jornada). Prazo declarado e barra de progresso por desejo **não existem
em nenhum lugar do código**.

## 2. A prova histórica: wish #3416 (avaliações do Jardim das Patinhas, 05/07/2026)

O dono pediu, em linguagem de cliente, **avaliações no site do Jardim das Patinhas** — o corpo da wish
citava "fotos e vídeos" e tinha **zero menção a marketplace**.

O RA, ancorado só nessa wish, achou **sozinho** três jornadas:

1. O comprador avaliando — e-mail → login → compra verificada → estrelas com foto e vídeo → selo.
2. A validação no servidor.
3. **A joia:** "Sincronização de Avaliações com Mercado Livre" — descoberta **100% pelo RA**, ao ver a
   integração com o ML já existente no codegraph. Ninguém tinha citado marketplace no pedido.

O cenário hipotético virou épico real (#3442). O PO devolveu 3 fases / 5 épicos / 8 features / 8
tarefas / 24 issues, com roadmap de 3 sprints datados. PRs #251-#254 foram mesclados e publicados.

Este caso é a referência de "o que é profundidade boa" ao avaliar qualquer saída de RA/PO — é
exatamente o efeito que o schema de `packages/cadence/src/rails.ts` foi desenhado para forçar.

## 3. Entrada: issue de desejo (Wishlist)

O gatilho real é uma issue do GitHub com a label `wishlist`
(`apps/control-plane/src/routes/github-webhook.ts` — `WISHLIST_LABEL`, `missionRoleForEvent`: issue
`opened` com essa label acorda o RA). Não há campo de prazo declarado nem UI de barra de progresso
associada a essa issue — o desejo é só o texto que o leigo escreveu.

## 4. Agendamento

| Papel | Cron | Fonte |
|---|---|---|
| RA | `0 6,18 * * *` (2x/dia) | `apps/control-plane/src/lib/project-defaults.ts:7` |

Todo projeto novo recebe essa agenda automaticamente e de forma idempotente
(`ensureDefaultSchedules`, `apps/control-plane/src/lib/project-defaults.ts:33-...`). Não existe
frequência configurável de 3/6/8/12h nem wake condicionado a "nova entrada na Wishlist" além do
webhook de `issues.opened` — o cron fixo acima é o comportamento real hoje.

## 5. Skills GSTACK — ROADMAP, não comportamento real

Busca no código (`apps/`, `packages/`, fora de testes) por chamadas a `/browse`, `/investigate`,
`/benchmark`, `/office-hours`, `/learn`, `/document-generate`, `/plan-eng-review`, `/cso`, `/careful`:
**zero ocorrências**. Nenhuma dessas skills é invocada pelo RA em produção hoje. A tabela abaixo é
aspiração de roadmap, não implementação:

| Skill (roadmap) | Finalidade pretendida |
|---|---|
| `/browse` | Pesquisa web estruturada |
| `/investigate` | Análise profunda de bugs e regressões |
| `/benchmark` | Comparar alternativas técnicas |
| `/office-hours` | Brainstorming de produto/técnico |
| `/learn` | Persistir descobertas analíticas |
| `/document-generate` | Gerar documentação técnica |
| `/plan-eng-review` | Validar tecnicamente propostas |
| `/cso` | Análise de segurança e compliance |
| `/careful` | Modo cuidadoso para refactors de alto impacto |

## 6. Colaboração com PO e SM

- **Com o PO:** o RA entrega `RaDeliverable` (áreas + jornadas + brief) formatado como memória; o PO
  lê esse texto como contexto obrigatório de todo passo do seu próprio roteiro
  (`apps/control-plane/src/services/po-rails-mission.ts:112-115`, bloco `base`).
- **Com o SM:** não há chamada direta RA→SM no código hoje; o acoplamento é indireto, via issues e
  board.

## 7. Limites

- O RA nunca inventa arquivo ou caminho — toda âncora de jornada tem que vir do contexto de código
  real montado para a missão (`packages/cadence/src/rails.ts:42`, "never invent" no prompt de áreas).
- O RA não executa código — produz o estudo (áreas, jornadas, brief) que alimenta o PO.
