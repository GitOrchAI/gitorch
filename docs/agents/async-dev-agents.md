# GitOrch — Async Dev Agents: Jules

**Status:** ATUAL — não é mais roadmap. A delegação assíncrona para o Jules é feita **pela API
completa** de sessões (`apps/control-plane/src/services/jules-client.ts`), acompanhada por uma
máquina de estados (`apps/control-plane/src/services/jules-session-loop.ts`).
**Correção 21/08/2026:** a versão anterior deste documento estava marcada "ROADMAP — não
implementado" e descrevia um mecanismo por label + detecção de PR aberto por `jules[bot]`. O código
evoluiu para a API e nunca voltou a ser documentado. Decisão do dono (D29), nas palavras dele:
*"eu tinha lá no começo pedido label mas api é muito melhor"* — a preferência declarada é pela API, e
é o que está implementado.

---

## 1. Visão Geral

O Jules é o dev agent externo assíncrono do GitOrch: recebe uma task já decomposta pelo PO (padrão
Shrimp completo na issue) e trabalha no repositório do usuário. O GitOrch não executa o código da
task — cria/gerencia a **sessão de trabalho** via API e acompanha até haver PR ou até a sessão
precisar de alguma ação do produto (aprovar plano, responder pergunta, insistir, desistir).

## 2. A API real (`jules-client.ts`)

Todas as chamadas usam `https://jules.googleapis.com/v1alpha`, com timeout de 15s e contrato de
degradação: sem chave, sem repositório conectado, ou com o serviço fora — a função devolve `null`
(ou `''`/`false` conforme o tipo) com aviso, e **nunca lança**. A etiqueta `jules` (ver §5) segue
valendo como plano B nesse cenário.

| Função | Linha | Chamada HTTP | O que faz |
|---|---|---|---|
| `julesSourceName` | `jules-client.ts:21` | — | Converte `dono/repo` em `sources/github/dono/repo` |
| `criarSessaoJules` | `jules-client.ts:45` | `POST /sessions` (linha 57) | Cria a sessão de trabalho; devolve o identificador (`sessions/...`) usado no resto do ciclo de vida. Passa `automationMode: 'AUTO_CREATE_PR'` (linha 72) — o PR é criado automaticamente pelo Jules ao concluir |
| `consultarSessaoJules` | `jules-client.ts:150` | `GET /{session}` (linha 160) | Lê estado, número do PR (extraído dos outputs) e timestamp da última atualização |
| `responderSessaoJules` | `jules-client.ts:220` | `POST /{session}:sendMessage` (via `chamarMetodoDaSessao`, linha 185) | Manda mensagem — **único** jeito de destravar uma sessão parada, já que a API não tem `resume`/`continue`/`pause` (verificado: respondem 404) |
| `aprovarPlanoJules` | `jules-client.ts:231` | `POST /{session}:approvePlan` | Aprova o plano da sessão, sem gastar motor — o contrato já está na issue |
| `ultimaMensagemDoDevJules` | `jules-client.ts:257` | `GET /{session}/activities?pageSize=100` (linha 267) | Lê a última mensagem do Jules na sessão, usada para decidir pergunta pendente |

O número do PR é extraído por `numeroDoPrDaSaida` (`jules-client.ts:129-141`) — só o **número**, nunca
a URL vinda de fora, para não repetir a classe de falha de SSRF já corrigida neste repositório (dado
de fora virando alvo de chamada nossa). A âncora de regex exige que `/pull/<n>` seja seguida de fim,
barra, `?` ou `#`, para não casar `/pull/63x`.

## 3. Máquina de estados (`jules-session-loop.ts`)

`decidirRespostaDaSessao` (linhas 51-112) olha só o estado da sessão — sem tocar rede nem banco — e
devolve uma ação (`DecisaoDaSessao.acao`, linhas 24-25):

| Estado da sessão | Ação | Linha |
|---|---|---|
| `COMPLETED` com PR entregue | `julgar` | 64-67 |
| `COMPLETED` sem PR (trabalho morreu dentro da sessão) | `investigar` | 64-67 |
| `FAILED` / `CANCELLED` | `investigar` | 70-72 |
| `AWAITING_PLAN_APPROVAL` | `aprovar-plano` | 74-79 |
| `AWAITING_USER_FEEDBACK` | `responder` (com o contexto da pergunta + contrato da issue) | 81-99 |
| `IN_PROGRESS` / `QUEUED` / `PLANNING`, parada há ≥90 min (`PARADO_MS`, linha 39) ou `PAUSED` | `insistir` (até `MAX_NUDGES = 3`, linha 42) ou `abandonar` se já insistiu 3x | 101-109 |
| `IN_PROGRESS` / `QUEUED` / `PLANNING`, avançando | `aguardar` | 111 |
| Estado desconhecido | `aguardar` (deliberado — agir às cegas sobre estado novo é pior que esperar) | 47-50 |

Isso cobre exatamente os estados citados na API: `COMPLETED`, `FAILED`, `CANCELLED`,
`AWAITING_PLAN_APPROVAL`, `AWAITING_USER_FEEDBACK`, `IN_PROGRESS`, `QUEUED`, `PLANNING`, `PAUSED`.

Sem método de retomada nativo na API, a **única** forma de destravar uma sessão parada é
`responderSessaoJules` pedindo para continuar (ação `insistir`).

## 4. A etiqueta `jules`: ainda existe, mas só como marcação

A etiqueta continua sendo aplicada na delegação
(`apps/control-plane/src/services/sm-delegation.ts:98` — `label = options.delegateLabel ?? 'jules'`;
linhas 155-157 — `POST .../labels` aplicando a label na issue), e é usada para:

- Filtrar candidatas a delegar (`sm-delegation.ts`, busca por issues com `TASK_LABEL` aberto).
- Sinalizar visualmente no GitHub qual agente está com a issue (`aplicarLabelDoAgente`).
- Servir de sinal secundário de "PR delegado" no julgamento do QA quando não há linha de sessão salva
  (`ehPrDelegado`, ver `apps/control-plane/src/services/qa-rails-mission.ts`).

Mas o comentário do próprio código é explícito sobre o papel real dela hoje
(`sm-delegation.ts:182-184`): *"O label marca a issue; a sessão é quem efetivamente põe o dev a
trabalhar."* Quem aciona o Jules de verdade é `criarSessaoJules` (chamado logo depois, linha 186) — a
etiqueta, sozinha, não faz nada acontecer no Jules.

## 5. Furo conhecido: a janela cega de casamento PR↔sessão

O número do PR só aparece quando o Jules **popula os outputs** da sessão
(`numeroDoPrDaSaida(outputs)`). Medido em produção (20/08/2026): PR #132 aberto às 16:58, ligação
gravada às 23:28 — **seis horas e meia** de janela cega, durante a qual o QA podia acordar pelo aviso
de CI, não achar a linha da sessão, e julgar a própria entrega do produto como obra de terceiro. Uma
correção parcial existe (`ligarPrDaEntrega`,
`apps/control-plane/src/routes/github-webhook.ts:78-...`, grava a ligação assim que o webhook de PR
aberto chega) — mas o vigia dessa ligação ainda não foi observado ao vivo casando um PR não ligado
(sem PR desse tipo disponível para reproduzir no momento da verificação).

## 6. Agentes e Runtimes Futuros — ainda ROADMAP

Isto continua roadmap, sem mudança:

| Candidato | Status |
|---|---|
| Codex | Futuro |
| Claude Code | Futuro |
| GitHub Copilot | Futuro |
| OpenCode | Futuro |
| Antigravity | Futuro |
| Hermes | Futuro |

## 7. Permissões do GitHub App

Para a API de sessões funcionar, além das permissões originalmente previstas
(`metadata:read`, `contents:read`, `issues:write`, `pull_requests:read`), o merge automático (§ ver
`docs/agents/product-owner.md`/decisão D7) usa também escrita em pull requests. Revisar o manifesto
real do GitHub App do projeto antes de assumir qualquer escopo — este documento não é fonte de
verdade para permissões concedidas.

## 8. Referências

- `apps/control-plane/src/services/jules-client.ts`
- `apps/control-plane/src/services/jules-session-loop.ts`
- `apps/control-plane/src/services/sm-delegation.ts`
- `apps/control-plane/src/services/qa-rails-mission.ts` (`ehPrDelegado`)
- `apps/control-plane/src/routes/github-webhook.ts` (`ligarPrDaEntrega`)
