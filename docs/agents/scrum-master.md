# GitOrch – SM Agent (Scrum Master)

**Status:** ATUAL — runtime real em `apps/control-plane/src/services/sm-delegation.ts`
(`runSmDelegation`) e `apps/control-plane/src/services/sm-watchdog.ts`.
**Correção 21/08/2026:** a versão anterior descrevia retroativa semanal, "1% ao dia" e o SM acionando
o QA — nenhum dos três foi encontrado no código. Decisão do dono (D29): código manda.

## 1. Papel do SM no GitOrch

O SM garante que o trabalho **flua**: escolhe quais issues delegar ao Jules a cada ciclo, respeitando
dependências e teto de concorrência, e escala (não re-delega) o que trava.

## 2. Delegação (`runSmDelegation`, `sm-delegation.ts:94-...`)

A cada ciclo:

1. Busca issues abertas com a label de task (`TASK_LABEL`), excluindo as que já têm sessão viva
   (`comSessaoViva`, linha 125).
2. Para cada candidata, conta bloqueadores ainda abertos extraídos do corpo da issue
   (`extractBlockers`).
3. `escolherParaDelegar` (`fila-de-delegacao.ts:24`) decide quais delegar, respeitando teto de
   concorrentes, teto diário e **cap por ciclo — padrão 3** (`sm-delegation.ts:99`,
   `cap = options.cap ?? 3`). Isto confere com a versão anterior do documento.
4. Para cada escolhida: aplica a label de delegação (`sm-delegation.ts:155-157`), atualiza a label de
   agente (`aplicarLabelDoAgente`), e cria a sessão real no Jules via `criarSessaoDev`
   (`sm-delegation.ts:185-198` — ver `docs/agents/async-dev-agents.md`).

**O que a versão anterior errava:** não há, no código de delegação, uma auditoria de "campos
obrigatórios da issue" que bloqueie a delegação por formato fora do padrão Shrimp. Essa estrutura
(`Goal`, `Task Details`, `Implementation Guide`, `Verification Criteria`, `Dependencies`,
`Related Files`, `Notes`) já é **forçada por schema na origem**, quando o PO gera a issue
(`validateDoD` / `DOD_FIELD_MAP`, `apps/control-plane/src/services/backlog-executor.ts:1,79` —
`packages/cadence/src/rails.ts:41-50`) — o SM não precisa (nem faz) essa auditoria posterior porque a
issue já nasce no formato certo.

## 3. Watchdog (`sm-watchdog.ts`) — SÓ ESCALA, não re-delega

Para issues com sessão travada além do número máximo de tentativas
(`retryCount >= maxRetries`, `sm-watchdog.ts:130`):

1. Aplica `STUCK_LABEL` (idempotente — pula se já aplicada).
2. Comenta na issue avisando que o dev assíncrono falhou N vezes e está escalando para revisão
   humana.
3. Notifica (Telegram), se configurado.

(`sm-watchdog.ts:132-148`)

O código é explícito sobre o que **não** faz mais (`sm-watchdog.ts:149-154`): *"O retentar NÃO mora
mais aqui. Reaplicar a etiqueta era inerte: a fila de delegação escolhia justamente as issues SEM a
etiqueta, então a issue reaplicada nunca voltava a ser escolhida."* Quem cobra reentrega hoje é a
linha da sessão (`fila-de-delegacao.ts`): sessão fechada sem merge devolve a issue para a fila no
próximo ciclo, sozinha — não é o watchdog quem re-delega.

## 4. O que NÃO foi encontrado no código

- **Retroativa semanal** (`[MEMORY key="sm-retro-YYYYWNN"]` com % de entrega, QA fail rate, etc.):
  busca no código por padrões equivalentes não encontrou nada. Não implementado.
- **"1% ao dia"** (sempre 1 micro-task de melhoria em andamento): não encontrado no código.
- **"SM aciona o QA"**: não encontrado. Quem acorda o QA é webhook do GitHub + agenda própria — ver
  `docs/agents/quality-assurance.md §2`. O SM não chama `runQaMissionViaRails` em nenhum ponto.

Estes três permanecem como possível ROADMAP, não como comportamento atual — se o dono quiser
implementá-los, são itens novos, não bugs de regressão.

## 5. Agendamento — ATUAL

```
{ agentRole: 'sm', cron: '0 5,11,17,23 * * *' }  // 4x/dia
```
(`apps/control-plane/src/lib/project-defaults.ts:9`)

A versão anterior descrevia 3h/dia com início às 1h — não confere com o código. O cron real é fixo,
sem slider de frequência configurável.

## 6. Interação com Dev Agents

- Só delega issues cujo formato já veio certo do PO (não audita formato — ver §2).
- Coordena teto de concorrência e cap por ciclo.
- Escala (não re-delega) sessões travadas — ver §3.
- **Não** aciona o QA.

## 7. Limites e Interações Humanas

- Nunca aprova PRs — isso é papel do QA (`docs/agents/quality-assurance.md`).
- Escalar para humano é o único mecanismo de "pedir ajuda" que o watchdog tem hoje: aplica label +
  comentário + notificação, e para aí.
