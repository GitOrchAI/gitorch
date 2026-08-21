# GitOrch – QA Agent (Quality Assurance)

**Status:** ATUAL — runtime real em `apps/control-plane/src/services/qa-rails-mission.ts`
(`runQaMissionViaRails`) e mescla em `apps/control-plane/src/services/merge-do-pr.ts`.
**Correção 21/08/2026:** a versão anterior descrevia "o SM é o orquestrador do QA" e um slider de
níveis de autonomia 2/3/4 — nenhum dos dois existe no código. Decisão do dono (D29): código manda.

## 1. Papel do QA no GitOrch

O QA compara o que foi pedido (Verification Criteria da issue) com o que foi entregue (diff do PR) e
emite um veredito. `runQaMissionViaRails` é o único ponto de entrada — não há um modo separado de
"auditoria de saúde"; toda vez que o QA acorda (por qualquer gatilho), ele roda essa mesma missão.

## 2. Quem acorda o QA — ATUAL

Dois mecanismos reais, nenhum deles é "o SM orquestrando":

### 2.1. Webhook do GitHub

`missionRoleForEvent` (`apps/control-plane/src/routes/github-webhook.ts:34-64`) decide o papel a
acordar a partir do evento recebido:

- `pull_request` com `action: 'opened'` e autor contendo `jules` → acorda `qa` (linha 51-54).
- `check_suite` ou `workflow_run` com `action: 'completed'` **e** que carregue PR(s) no payload →
  acorda `qa` (linha 61-64). Deliberadamente restrito a eventos com PR associado: antes acordava em
  qualquer conclusão de CI, mesmo sem PR, e virava rajada de missões que só respondiam "nada a
  julgar" — gastando cota do motor do cliente à toa.

### 2.2. Agenda própria (cron) — criada em 21/08/2026

```
{ agentRole: 'qa', cron: '0 0,8,16 * * *' }
```
(`apps/control-plane/src/lib/project-defaults.ts:22`)

Até 21/08/2026 o QA **não tinha agenda própria** em `project_schedules` — só `ra`, `po` e `sm` tinham.
Isso deixava o QA dependente só do webhook: um PR cuja verificação terminou há dias e cuja conversa
com o dev já encerrou não tinha quem chamasse o QA. Observado em produção: entregas prontas ficaram
paradas desde 09/08/2026, com CI verde, sem nenhum parecer; e na virada de 21/08 o relógio disparou RA
e SM e nenhum QA. O horário `0 0,8,16` foi escolhido para não colidir com RA (6,18), PO (3,15) e SM
(5,11,17,23) — a colisão não quebraria nada, mas empurraria a fila de concorrência à toa.

**Importante:** essa agenda não roda um modo distinto de "auditoria de segurança/qualidade/
performance" com achados categorizados — ela apenas dá ao QA outra chance de encontrar e julgar PRs
delegados abertos, fechando a lacuna de quando nem webhook nem sessão avisam. A Fase 3 "Auditoria de
Saúde" descrita em versões antigas deste documento (achados de segurança/qualidade/performance/
vulnerabilidades em `[MEMORY key="qa-health-<data>"]`) **não existe no código hoje** — é
comportamento de ROADMAP, não real.

### 2.3. O SM também aciona o QA — ATUAL (21/08/2026)

A versão antiga deste documento (§3.1) dizia *"O SM é o orquestrador do QA — não um webhook, não um
trigger automático direto"*, e por muito tempo o código fazia o oposto: só webhook + cron. O furo era
real e foi medido — o PR #97 ficou parado desde 15/08 com a verificação verde, porque a verificação
tinha terminado dias antes (nenhum aviso novo do GitHub) e a sessão do dev já havia encerrado
(nenhuma vigília para acordar o QA).

**O que existe hoje:** a cada acordar do SM, `runSmDelegation`
(`apps/control-plane/src/services/sm-delegation.ts`) lista as PRs abertas e separa as que **não têm
parecer nosso no head atual** — a MESMA leitura que o laço de descoberta do QA usa
(`apps/control-plane/src/services/parecer-do-qa.ts`, importado pelos dois). Cada uma vira uma vez na
fila de julgamento (`apps/control-plane/src/services/fila-de-julgamento.ts`), e o tique do relógio
drena **uma por minuto** (`drenarFilaDeJulgamento` em `apps/control-plane/src/plugins/scheduler.ts`).

Três guardas contra virar rajada:

1. **Cap por ciclo** (`CAP_PADRAO_DE_JULGAMENTO`, hoje 3) — mesmo desenho e mesmo número do cap de
   delegação do SM.
2. **Uma por tique**, com rodízio entre projetos — o teto de concorrência do relógio (hoje 1) já
   seguraria, mas segurar depois de pedir só geraria recusas por ocupado.
3. **Subconjunto estrito do que o QA aceita julgar** — o SM só enfileira PR sem NENHUM parecer no
   head atual, então nenhuma acordada pedida por este caminho chega lá para descobrir que não tinha
   nada a fazer.

A fila vive em memória de propósito: o critério é o estado do GitHub, não uma anotação nossa, então
toda acordada do SM a redescobre inteira e reiniciar o processo não perde nada. O webhook e a
vigília continuam existindo — este caminho é o que cobre a entrega que nenhum dos dois enxerga.

## 3. Como o QA decide o que julgar — ATUAL

`runQaMissionViaRails` busca as PRs abertas do repositório (até 20, mais recentes primeiro) e usa
`ehPrDelegado` para marcar cada uma como delegada (entrega do Jules) ou não — mas **julga todas**,
delegada ou de humano (decisão do dono: "julga todos, mescla só o que delegou"). O sinal de "já
julgada" é checar se **já existe uma review nossa neste mesmo head SHA** direto na API do GitHub — não
uma chave de memória do tipo `qa-pr-{prNumber}-{headSha}` no Cortex como versões antigas deste
documento descreviam. Força-push muda o head SHA e portanto conta como novo julgamento,
naturalmente, sem mecanismo de deduplicação separado.

## 4. Merge — ATUAL, sem slider de autonomia

`apps/control-plane/src/services/merge-do-pr.ts:8`: *"Decisão do dono (D7): o produto mescla sozinho
desde o primeiro ciclo, sem confirmação humana."* Busca no código inteiro por `autonomyLevel`,
`nivelDeAutonomia` ou `autonomia` (fora de testes): **zero ocorrências**. Não existe nível 2/3/4, não
existe slider em `/settings`, não existe opção de "aprova sem mesclar". O QA aprova e mescla no mesmo
ciclo, guardado por cinco checagens determinísticas (não este documento, ver o comentário no topo do
arquivo): PR precisa estar marcado como delegado; o SHA revisado tem que ser igual ao SHA atual
(aprovação não se transfere para código que ninguém viu); mais três checagens preexistentes (CI
verde, critérios do QA atendidos, diff completo revisado).

A tabela de "Gates por runtime" (97%/95%/90%) e a estrutura `[MEMORY key="qa-gap-pr<N>"]" de versões
antigas **não foram encontradas no código** — permanecem como ideia de roadmap, não implementação.

## 5. Filosofia (isto continua valendo, é princípio, não implementação)

> "Build verde não é qualidade. HTTP 200 não é qualidade. QA prova que o que foi pedido foi
> entregue."

## 6. Skills GSTACK do QA — ROADMAP

Mesma checagem feita para o RA: nenhuma chamada a `/qa`, `/qa-only`, `/review`, `/cso`, `/browse`,
`/design-review`, `/benchmark`, `/canary` foi encontrada em código de produção. Permanecem como
candidatas de roadmap.

## 7. Limites e Interações Humanas

- QA nunca emite aprovação sem ter lido o diff e comparado com os critérios da issue vinculada.
- PR sem issue vinculada, ou issue sem `verificationCriteria` no padrão Shrimp, bloqueia o julgamento
  automático.
