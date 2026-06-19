# 🐙 GitOrch — Plano de Controle de Orquestração Multi-Agente

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)

[English](README.md) | [Español (ES)](README.es.md)

O **GitOrch** é um plano de controle (control plane) de orquestração multi-agente de alta performance, projetado para governar equipes coordenadas de agentes de inteligência artificial (Product Owner, Scrum Master, Requirements Analyst, Quality Assurance) operando diretamente sobre repositórios do GitHub.

Ele integra o **CodeSight** para inteligência estrutural de código e o **Cortex** para retenção de memória semântica e espacial a longo prazo.

---

## 🚀 Início Rápido (CodeSight Core)

O pacote `@gitorch/codesight` (CGC) provê toda a inteligência sintática e o motor de persistência de grafos.

### Instalação

```bash
pnpm install
```

### Inicializando e Indexando o Código

```javascript
const { KuzuClient, TreeSitterManager, CodeGraphIndexer } = require('@gitorch/codesight');

async function run() {
  // Inicializa KuzuDB em memória ou no disco
  const client = new KuzuClient(':memory:');
  const manager = new TreeSitterManager();
  const indexer = new CodeGraphIndexer(client, manager);

  // Inicializa tabelas e arestas
  await indexer.initializeSchema();

  // Indexa um arquivo de código
  const code = `
    export function helloWorld() {
      return "Hello, World!";
    }
  `;
  await indexer.indexFile('src/hello.ts', code, 'typescript');
  console.log("Indexação concluída!");
  
  await client.close();
}

run().catch(console.error);
```

---

## 🏗️ Roadmap do MVP

O projeto segue um ciclo de desenvolvimento ordenado por risco técnico (Risk-First) composto por 12 fases:

- [x] **Fase F0: Fundações** — Setup do monorepo, Vitest, linting e CI.
- [x] **Fase F1: CodeSight Core** — Tree-sitter WASM, exportação SCIP e análise de impacto.
- [ ] **Fase F2: Cortex 4-Layer** — Camada de memória espacial baseada em SQLite + ChromaDB. *(Próximo passo)*
- [ ] **Fase F3: Pipeline de Graph RAG** — Sequência de processamento de consultas semânticas.
- [ ] **Fase F4: Synapse + Feromônios** — Orquestração estigmérgica de agentes.
- [ ] **Fase F5: Sincronização GitHub & Projects V2** — Sincronização de backlog e integrações.
- [ ] **Fase F6: Agentes** — Runtimes dos agentes integrados (PO, SM, RA, QA).
- [ ] **Fase F7: Workspace Engine** — Execução isolada de testes e ambientes de compilação.
- [ ] **Fase F8: API do Plano de Controle** — API Gateway com Fastify.
- [ ] **Fase F9: Frontend Mission Control** — Dashboard visual em React.
- [ ] **Fase F10: Secrets Vault & Autenticação** — Criptografia de chaves no lado do cliente.
- [ ] **Fase F11: Observabilidade & Robustecimento** — Auditoria de conformidade e telemetria.

---

## 📚 Documentação Oficial

Toda a documentação técnica voltada para o usuário e comunidade está hospedada na **Wiki do GitHub** deste repositório. Clique na aba **Wiki** no topo desta página no GitHub para acessar guias como:

* **Guia de Início Rápido:** Primeiros passos indexando código com CodeSight.
* **Visão Geral da Arquitetura:** Como o CodeSight e o Cortex cooperam.
* **Manuais e Guias de Uso:** Consultando o grafo de código e configurando agentes.
* **Backlog e Roadmap:** Acompanhamento detalhado do desenvolvimento e novas funcionalidades.

---

## 🛠️ Comandos de Desenvolvimento

```bash
# Rodar desenvolvimento
pnpm dev

# Rodar linter
pnpm run lint

# Executar testes unitários
pnpm run test

# Compilar projetos
pnpm run build
```

---

## 📄 Licença

Este projeto é licenciado sob a licença **GNU Affero General Public License v3.0 (AGPL-3.0)**. Consulte o arquivo [LICENSE](LICENSE) para o texto completo.
