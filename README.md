# 🐙 GitOrch — Multi-Agent Orchestration Control Plane

[![License: AGPL v3](https://img.shields.5io/badge/License-AGPL%20v3-blue.svg)](LICENSE)

[Português (PT-BR)](README.pt-br.md) | [Español (ES)](README.es.md)

**GitOrch** is a high-performance multi-agent orchestration control plane designed to govern collaborative AI agent swarms (Product Owner, Scrum Master, Requirements Analyst, Quality Assurance) operating directly on GitHub repositories.

It integrates **CodeSight** for structural code intelligence and **Cortex** for long-term semantic and spatial memory retention.

---

## 🚀 Quick Start (CodeSight Core)

The `@gitorch/codesight` (CGC) package provides the syntactic intelligence and graph persistence engine.

### Installation

```bash
pnpm install
```

### Initializing and Indexing Code

```javascript
const { KuzuClient, TreeSitterManager, CodeGraphIndexer } = require('@gitorch/codesight');

async function run() {
  // Initialize KuzuDB in-memory or on disk
  const client = new KuzuClient(':memory:');
  const manager = new TreeSitterManager();
  const indexer = new CodeGraphIndexer(client, manager);

  // Initialize tables and edges
  await indexer.initializeSchema();

  // Index a code snippet
  const code = `
    export function helloWorld() {
      return "Hello, World!";
    }
  `;
  await indexer.indexFile('src/hello.ts', code, 'typescript');
  console.log("Indexing completed!");
  
  await client.close();
}

run().catch(console.error);
```

---

## 🏗️ MVP Roadmap

The project follows a Risk-First development cycle divided into 12 phases:

- [x] **Phase F0: Foundation** — Monorepo setup, Vitest, linting, and CI.
- [x] **Phase F1: CodeSight Core** — Tree-sitter WASM, SCIP export, and impact analysis.
- [ ] **Phase F2: Cortex 4-Layer** — Spatial memory layer based on SQLite + ChromaDB. *(Next step)*
- [ ] **Phase F3: Graph RAG Pipeline** — Semantic query processing sequence.
- [ ] **Phase F4: Synapse + Pheromones** — Stigmergic coordination of agents.
- [ ] **Phase F5: GitHub Sync & Projects V2** — Backlog synchronization and integration.
- [ ] **Phase F6: Agents** — Integrated agent runtimes (PO, SM, RA, QA).
- [ ] **Phase F7: Workspace Engine** — Isolated test execution and build environments.
- [ ] **Phase F8: Control Plane API** — Fastify API Gateway.
- [ ] **Phase F9: Mission Control Frontend** — Visual React dashboard.
- [ ] **Phase F10: Secrets Vault & Auth** — Client-side encryption of keys.
- [ ] **Phase F11: Observability & Hardening** — Compliance auditing and telemetry.

---

## 📚 Official Documentation

All user and community-facing technical documentation is hosted in the **GitHub Wiki** of this repository. Please click the **Wiki** tab at the top of the repository page to access guides such as:

* **Quickstart Guide:** Getting started with CodeSight indexing.
* **Architecture Overview:** How CodeSight and Cortex work together.
* **How-To Guides:** Querying the code graph and setting up agents.
* **Backlog and Roadmap:** Detailed tracking of upcoming features.

---

## 🛠️ Development Commands

```bash
# Run in development mode
pnpm dev

# Run linter
pnpm run lint

# Run unit tests
pnpm run test

# Compile projects
pnpm run build
```

---

## 📄 License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. See the [LICENSE](LICENSE) file for the full text.
