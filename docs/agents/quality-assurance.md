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

### 2.3. O que a versão antiga errava (§3.1)

*"O SM é o orquestrador do QA — não um webhook, não um trigger automático direto"* — o código faz
exatamente o oposto: é webhook + cron. O SM não chama o QA em nenhum ponto do código
(`apps/control-plane/src/services/sm-watchdog.ts` só escala issues travadas, ver
`docs/agents/scrum-master.md`). Isto é um **furo real** apontado pelo dono, não uma preferência de
documentação: um PR sem CI rodando e sem sessão registrada ainda pode ficar sem quem chame o QA entre
janelas de cron — virou item de acompanhamento separado, não resolvido por este documento.

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
