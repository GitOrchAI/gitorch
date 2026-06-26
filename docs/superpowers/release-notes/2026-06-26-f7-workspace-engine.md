# Release Notes: Fase 7 (F7) - Workspace Engine

**Data:** 2026-06-26  
**Status:** Concluído e Shippado  
**Escopo:** `@gitorch/workspace-engine`, `@gitorch/agents`  

## Visão Geral

A Fase 7 entrega o **Workspace Engine** do GitOrch, a camada de infraestrutura de nuvem que permite a execução de agentes CLI assíncronos (como Claude Code e Antigravity CLI) de forma totalmente isolada em instâncias de MicroVMs baseadas em **Firecracker** na máquina host ARM.

Esta infraestrutura viabiliza o "Cloud Mode" do GitOrch, garantindo isolamento total por inquilino (*tenant*) a nível de hypervisor KVM e reduzindo a ociosidade do host através de um mecanismo eficiente de hibernação.

---

## O que foi implementado

### 1. Provisionador de Infraestrutura ARM
* **Script de Bootstrap:** Criação do script [arm-vm-bootstrap.sh](file:///C:/Users/Admin/Documents/GitOrch/scripts/infra/arm-vm-bootstrap.sh) na pasta `scripts/infra/` para configuração automatizada do nó ARM, habilitando o suporte KVM e baixando os binários do Firecracker de forma idempotente e segura (validação via hash SHA256).

### 2. Pacote `@gitorch/workspace-engine`
* **WorkspaceManager ([manager.ts](file:///C:/Users/Admin/Documents/GitOrch/packages/workspace-engine/src/manager.ts)):**
  - **`allocateWorkspace(userId, projectId, config)`**: Inicializa uma MicroVM baseada em Firecracker, configurando o ambiente *chroot* e alocando um diretório seguro sob `/var/lib/gitorch/workspaces/[userId]/[projectId]`.
  - **`hibernateWorkspace(userId, projectId)`**: Cria um snapshot completo de memória e disco da MicroVM ativa e finaliza o processo do Firecracker (pkill seletivo), reduzindo o consumo de RAM ociosa a zero quando o agente finaliza sua rodada programada.
  - **`cloneRepositories` e `installRuntimes`**: Preparam os repositórios do inquilino no disco da MicroVM e instalam os runtimes CLI requisitados na sandbox.
* **AuthProxy ([auth-proxy.ts](file:///C:/Users/Admin/Documents/GitOrch/packages/workspace-engine/src/auth-proxy.ts)):**
  - Proxy interativo de streams (`EventEmitter`) projetado para capturar prompts de login (ex: do Anthropic Claude Code) e repassar chaves e tokens via stdin virtual de forma segura.
  - Mitigação de vazamentos de memória (*memory leaks*) via remoção explícita de listeners (`destroy()`) e proteção contra fragmentação de rede com um buffer deslizante acumulativo de 4KB.

### 3. Integração com `@gitorch/agents`
* **Mapeamento de Inquilino:** O payload de execução agora repassa o `userId` em todas as etapas de criação de missões.
* **Ciclo de Execução no Orquestrador:** Modificamos o [orchestrator.ts](file:///C:/Users/Admin/Documents/GitOrch/packages/agents/src/orchestrator.ts) para realizar a alocação do workspace seguro e garantir a hibernação da MicroVM em bloco `finally`, evitando vazamentos de recursos em caso de falha na missão.

---

## Mitigações de Segurança Aplicadas
* **Command Injection:** Desabilitado o uso de shells na invocação do sistema operacional; todas as interações com o hypervisor e utilitários de sistema utilizam `execFile` com arrays de argumentos separados.
* **Path Traversal:** Validação de segurança estrita em todas as etapas de `userId` e `projectId` usando a regex `/^[a-zA-Z0-9_-]+$/` antes de qualquer manipulação de diretório.

---

## Evidências de Teste e Qualidade
* **workspace-engine:** 15 testes de unidade passando (cobertura total de alocação, hibernação e AuthProxy).
* **agents:** 25 testes passando, validando mocks via `vi.hoisted` no orquestrador e testes específicos para a propagação de `userId` no construtor de missões.
* **Monorepo:** Suite global validada via `pnpm test` (Turbo cache indexado).
