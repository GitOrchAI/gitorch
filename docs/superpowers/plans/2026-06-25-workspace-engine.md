# Plano de Implementação: Workspace Engine (Fase 7)

> **Para workers agênticos:** SUB-SKILL OBRIGATÓRIA: Use `superpowers:subagent-driven-development` (recomendado) ou `superpowers:executing-plans` para implementar este plano task-por-task. Steps usam checkboxes — marque cada um conforme completa. Siga TDD rigoroso: escreva teste falhando primeiro, confirme que falha, implemente código mínimo para passar, confirme que passa.

**Spec de design:** `artifacts/implementation_plan.md`
**Data:** 2026-06-25
**Contexto:** `main`

## Mapeamento de Arquivos

Arquivos a criar:
- `packages/workspace-engine/package.json` — Setup do novo pacote workspace-engine no monorepo.
- `packages/workspace-engine/tsconfig.json` — Configuração do compilador TS.
- `scripts/infra/arm-vm-bootstrap.sh` — Script automatizado SSH para instalar Firecracker/containerd e habilitar KVM no ARM.
- `packages/workspace-engine/src/manager.ts` — Engine de alocação hierárquica (`userId -> projectId`), clone, instalação de runtimes e hibernação de Firecracker.
- `packages/workspace-engine/src/manager.test.ts` — TDD para o manager.
- `packages/workspace-engine/src/auth-proxy.ts` — Canal interativo (stdin/stdout tunnel) para autenticar os CLI runtimes.
- `packages/workspace-engine/src/auth-proxy.test.ts` — TDD para o auth proxy.

Arquivos a modificar:
- `packages/agents/src/agent-mission.ts` — Roteamento do Job para despachar comandos especificamente para a MicroVM do Workspace Engine alocado (via `manager.ts`) em vez do host direto.

---

## Task 1: Bootstrap do Pacote `@gitorch/workspace-engine`

**Objetivo:** Criar o novo pacote TypeScript dentro do ecossistema do pnpm workspace.
**Arquivos a modificar/criar:**
- `packages/workspace-engine/package.json` — Setup
- `packages/workspace-engine/tsconfig.json` — Config

**Steps:**
- [ ] 1. Crie `packages/workspace-engine/package.json` com nome `@gitorch/workspace-engine`, apontando para `dist/index.js`.
- [ ] 2. Crie `packages/workspace-engine/tsconfig.json` estendendo as configs padrão do repositório.
- [ ] 3. Execute `pnpm install` na raiz para linkar o workspace.
- [ ] 4. Commit: `git commit -m "chore: bootstrap @gitorch/workspace-engine package"`

**Critério de Done:**
- [ ] Pacote é reconhecido pelo pnpm (rodar `pnpm ls -r` lista ele).
- [ ] Compilação básica passa.

---

## Task 2: Script de Provisionamento de Infra ARM (Firecracker)

**Objetivo:** Criar o script bash idempotente para instalar Firecracker na máquina host.
**Arquivos a modificar/criar:**
- `scripts/infra/arm-vm-bootstrap.sh` — Script bash

**Steps:**
- [ ] 1. Crie `scripts/infra/arm-vm-bootstrap.sh`
- [ ] 2. Implemente a lógica: verificar privilégios root, habilitar/verificar KVM no ARM (`/dev/kvm`), baixar binários do firecracker e containerd (se não existirem).
- [ ] 3. Adicione lógica para criar o diretório base de discos persistentes por tenant (`/var/lib/gitorch/workspaces`).
- [ ] 4. Dê permissão de execução: `chmod +x scripts/infra/arm-vm-bootstrap.sh` (via shell command na execucao futura).
- [ ] 5. Commit: `git commit -m "feat: add ARM VM Firecracker bootstrap script"`

**Critério de Done:**
- [ ] Script possui "set -e" para fail-fast.
- [ ] Script é idempotente (pode rodar 2x sem falhar).

---

## Task 3: Gerenciador de Workspaces (Manager)

**Objetivo:** Implementar o core logic que orquestra a criação hierárquica e hibernação dos workspaces.
**Arquivos a modificar/criar:**
- `packages/workspace-engine/src/manager.ts` — Responsável pelas MicroVMs
- `packages/workspace-engine/src/manager.test.ts` — Testes

**Steps:**
- [ ] 1. Escreva o teste falhando em `manager.test.ts` validando a API `allocateWorkspace(userId, projectId, config)` e `hibernateWorkspace()`.
- [ ] 2. Execute `pnpm --filter @gitorch/workspace-engine test` — confirme que falha.
- [ ] 3. Implemente as interfaces base e mocks da classe em `manager.ts`.
- [ ] 4. Execute o teste — confirme que passa.
- [ ] 5. Adicione testes e implementação para `cloneRepositories` (simulado/mocked).
- [ ] 6. Adicione testes e implementação para `installRuntimes` (simulado/mocked).
- [ ] 7. Commit: `git commit -m "feat: implement workspace manager with Firecracker lifecycle APIs"`

**Critério de Done:**
- [ ] Teste específico passa.
- [ ] O código suporta hierarquia isolada (User -> Project).
- [ ] Sem chamadas reais ao host (no test ambiente usa execa mocked ou stubs).

---

## Task 4: Canal Interativo de Autenticação

**Objetivo:** Criar o proxy de streams para transmitir stdin/stdout entre o runtime (ex: ClaudeCode) e o frontend.
**Arquivos a modificar/criar:**
- `packages/workspace-engine/src/auth-proxy.ts` — Proxy
- `packages/workspace-engine/src/auth-proxy.test.ts` — Testes

**Steps:**
- [ ] 1. Escreva teste falhando garantindo que o AuthProxy detecta prompts conhecidos (ex: "token:") no buffer stdout.
- [ ] 2. Execute o teste — confirme falha.
- [ ] 3. Implemente `auth-proxy.ts` com streams do Node (PassThrough ou event emitters).
- [ ] 4. Execute o teste — confirme passagem.
- [ ] 5. Escreva teste para injeção de resposta (`proxy.provideAnswer("my-token")`) no stdin virtual.
- [ ] 6. Execute testes — confirme passagem.
- [ ] 7. Commit: `git commit -m "feat: add interactive auth proxy for CLI runtimes"`

**Critério de Done:**
- [ ] Teste passa manipulando streams virtualizados.
- [ ] Tratamento seguro de timeouts caso o usuário nunca responda.

---

## Task 5: Integração com os Agentes Atuais

**Objetivo:** Interceptar chamadas locais e enviá-las para o Workspace Engine.
**Arquivos a modificar/criar:**
- `packages/agents/src/agent-mission.ts` — Integrar `manager.ts`

**Steps:**
- [ ] 1. Escreva teste falhando em `packages/agents/src/agent-mission.test.ts` (se existir, ou crie) verificando a delegação de comando.
- [ ] 2. Atualize `agent-mission.ts` importando e instanciando o `WorkspaceManager`.
- [ ] 3. Mapeie que o Job Execution agora requisita um workspace (usando o `userId` e `projectId` do context da DB), executa na MicroVM, e hiberna após receber o signal de "Job Done".
- [ ] 4. Teste todo o monorepo `pnpm test`.
- [ ] 5. Commit: `git commit -m "feat(agents): delegate execution to workspace-engine firecracker instances"`

**Critério de Done:**
- [ ] Todos os pacotes compilan perfeitamente.
- [ ] Nenhuma quebra retroativa para operações triviais que não demandam VM.
