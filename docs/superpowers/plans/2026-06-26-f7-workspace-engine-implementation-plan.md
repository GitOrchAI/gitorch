# Plano de Implementação: Fase 7 (F7) - Workspace Engine

**Data:** 2026-06-26  
**Status:** Aprovado e Implementado  

## 1. Motivação e Objetivos

Oferecer um ambiente de nuvem seguro ("Cloud Mode") para usuários que não têm capacidade de rodar runtimes pesados de agentes IA localmente na própria máquina.
O Workspace Engine provisiona workspaces isolados na VM ARM de 12GB do GitOrch, executando runtimes CLI (Claude Code, Antigravity CLI) com total isolamento.

---

## 2. Arquitetura e Decisões de Design

### Isolamento de Execução: Firecracker (MicroVMs)
* **Decisão:** Usar MicroVMs Firecracker rodando sobre KVM no nó ARM em vez do gVisor.
* **Justificativa:**
  - Baixo overhead de RAM (~5MB de RAM por MicroVM ociosa).
  - Segurança forte contra execução de código não confiável gerado por IAs, isolando o host a nível de hardware via virtualização de CPU/KVM.
  - Snapshot de estado para permitir hibernação completa e liberação instantânea de memória física ao término da tarefa.

### Canal de Autenticação (Auth Proxy)
* **Necessidade:** Runtimes de IA como Claude Code requerem login interativo por prompt que normalmente exige interação do usuário (ex: colar tokens).
* **Solução:** `AuthProxy` intercepta prompts na stdout do processo e transmite para o banco de dados/Synapse para coleta no frontend, injetando o token de resposta via stdin.
* **Resiliência:** Buffer deslizante de 4KB previne quebras decorrentes de fragmentação em streams TCP/Unix sockets.

---

## 3. Estrutura de Pacotes

* `@gitorch/workspace-engine`:
  - `WorkspaceManager`: Aloca instâncias microVM chroot sob `/var/lib/gitorch/workspaces/[userId]/[projectId]`, copia repositórios, instala runtimes e gerencia hibernação.
  - `AuthProxy`: Gerenciador de stream interativo de E/S.
* `@gitorch/agents`:
  - Roteia os comandos de missões para rodar dentro da sandbox alocada e hiberna a MicroVM no término da execução.

---

## 4. Plano de Verificação

### Testes de Unidade
- Validação do fluxo de `allocateWorkspace` e `hibernateWorkspace`.
- Teste interativo com `AuthProxy` injetando respostas no stream virtual.
- Teste de integração de orquestração com mocks via `vi.hoisted`.

### Mitigação de Vulnerabilidades
- Validação estrita de diretórios de inquilino para anular Path Traversal.
- Sem uso de shells em chamadas de subprocesso para evitar Command Injection.
