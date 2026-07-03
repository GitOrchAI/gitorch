# Ignição Real — Executor local-process + Motor Antigravity OAuth

**Data:** 2026-07-03
**Branch:** `feat/ignition-local-executor`
**Contexto:** design doc aprovado pelo owner em `~/.gstack/projects/loureng-gitorch/ubuntu-main-design-20260703-140502.md`

## Por quê

Duas semanas sem nenhuma missão executada. Diagnóstico (verificado em logs, não deduzido):

1. `gitorch-qa-worker` em crash-loop desde ~14/jun (324 mil restarts): o app `apps/qa-worker`
   foi removido do repo na reestruturação F5–F8, mas a unit systemd continuou apontando pra ele.
2. 100% das missões do scheduler falhavam com `spawn jailer ENOENT`: a F7 (Workspace Engine)
   exige Firecracker/KVM e **esta VM Oracle A1 não tem `/dev/kvm`** — inviável neste host.
3. Mismatch de credencial: scheduler passava credencial `antigravity` com runtime default
   `claude` (RA) / `codex` (PO).
4. Mascaramento: missão que falhava ficava presa em `running` com `error` NULL — invisível.

## O que mudou

### Executor configurável (`GITORCH_EXECUTOR`)
- `local-process` (default): `LocalWorkspaceProvider` aloca diretório em
  `/var/lib/gitorch/workspaces/<user>/<project>` e clona/atualiza o repositório do projeto
  (`git clone --depth 1` via credencial do `gh`). Sem MicroVM.
- `firecracker`: comportamento antigo (`WorkspaceManager`), para hosts com KVM.
- Costura: `AgentOrchestrator` agora aceita `workspace: WorkspaceProvider` injetável.

### Motor dos agentes = Antigravity CLI via OAuth
Diretriz do owner (2026-07-03): **todos os motores autenticam por OAuth**
(Antigravity CLI, Codex CLI, Claude Code CLI) — nunca por chave de API.

- Adapter: `agy --print --sandbox --print-timeout 20m --add-dir <workspace> --model <modelo>`.
- **Por que `--sandbox`** (comprovado em QA real 2026-07-03): `--print` sozinho
  **trava** no primeiro uso de ferramenta esperando aprovação sem TTY. `--sandbox`
  ADICIONA restrições de terminal e auto-aprova ferramentas DENTRO do sandbox —
  é o oposto de `--dangerously-skip-permissions` (que desliga aprovações e não é usado).
- **Por que `--add-dir <workspace>`**: sem isso o `agy` analisa o "projeto ativo"
  dele (o próprio GitOrch), não o repositório clonado da missão.
- **Por que fechar o stdin (`child.stdin.end()`)** (comprovado em QA real 2026-07-03,
  testes A/B/C/D): em `--print` o `agy` lê o stdin antes de começar e espera o EOF.
  O `execFile` do Node mantém o pipe de stdin aberto, então o processo trava para
  sempre (`fd 0` em `unix_stream_data_wait`, 0% CPU, log interno vazio). Fechar o
  stdin manda o EOF e o motor arranca. O runner CLI e o runner Python fazem isso.
- Prompts de agente são read-only e proibidos de rodar install/build/lint/test
  (lentos, estouram o timeout) — a análise sai da leitura direta do código.
- Modelos (plano de ignição 2026-07-02): PO = `Gemini 3.1 Pro (Low)`;
  RA/SM/QA = `Gemini 3.5 Flash (Medium)`. Overrides: `GITORCH_MODEL_PRO/FLASH`.
- Login: OAuth Google concluído na VM em 2026-07-03 (fluxo de código via
  `antigravity.google/oauth-callback` — funciona sem navegador local).
- Fallback declarado: Codex CLI (`codex exec`) — requer `codex login` prévio.
- `GITORCH_ANTIGRAVITY_MODE=api` mantém o runner REST Gemini
  (`runtime/run_antigravity_sdk.py`) apenas para diagnóstico; o SDK python
  `google-antigravity` não roda nesta VM (exige glibc ≥ 2.36; Ubuntu 22.04 tem 2.35).
- Sem flags de bypass de permissão embutidas; extras explícitos via `GITORCH_AGY_EXTRA_ARGS`.

### Guardas operacionais (scheduler)
- Falha de missão persiste: `status='failed'`, `error` preenchido, `completedAt`.
- Missão presa em `running` > 2h (`GITORCH_STALE_RUNNING_MS`) → marcada `failed`.
- Orçamento: máx. 4 missões/dia por agente (`GITORCH_MAX_MISSIONS_PER_DAY`); sem retry em loop.
- Concorrência 1: nunca duas missões simultâneas (RAM da VM: ~11GB, ~3,6GB livres).
- `POST /api/missions/agent-run` `{role}`: dispara missão sob demanda pelo mesmo caminho.

### Infra (systemd)
- `gitorch-qa-worker.service`: **desativado** (zumbi da arquitetura antiga).
- `gitorch-control-plane.service` drop-in: `MemoryMax=3G`, `MemorySwapMax=0`,
  `GITORCH_EXECUTOR=local-process`.
- `gitorch-watchdog.timer` (15 min): missão presa > 2h; > 3 restarts/h por serviço;
  falhas de missão nos últimos 20 min; heartbeat diário 09:00. Alertas via Telegram
  (`@GitOrchBot`) quando `TELEGRAM_CHAT_ID` estiver no `.env`; sempre no journal.
  Unidades versionadas em `scripts/ops/`.

## Agenda dos agentes (inalterada)
RA 00:00 · PO 03:00/15:00 · SM 05:00/11:00/17:00/23:00 · QA por webhook de PR.

## Gate de segurança do SaaS
Nenhum cliente externo entra nesta VM antes do executor containerizado (Podman)
estar ativo — o modo `local-process` é aceitável apenas single-tenant (o owner).

## Pendências conhecidas
- `TELEGRAM_CHAT_ID` vazio: owner precisa mandar `/start` para `@GitOrchBot` e o
  chat id ser gravado no `.env` para os alertas chegarem no Telegram.
- Codex CLI sem login (`codex login` interativo pendente) — fallback inativo até lá.
- Fase 2: executor containerizado (Podman) antes do primeiro cliente externo.
