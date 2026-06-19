# GitOrch - Multi-Agent Orchestration Control Plane

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)

[Portuguese (PT-BR)](README.pt-br.md) | [Spanish (ES)](README.es.md)

**GitOrch** is a multi-agent orchestration control plane for engineering workflows on GitHub repositories.

It currently ships two core building blocks:

- **CodeSight** for structural code intelligence, indexing, impact analysis, and SCIP export
- **Cortex** for layered memory retrieval backed by SQLite and ChromaDB

---

## Quick Start (CodeSight Core)

The `@gitorch/cgc` package provides the graph indexing engine.

### Installation

```bash
pnpm install
```

### Initialize and Index Code

```javascript
const { KuzuClient, TreeSitterManager, CodeGraphIndexer } = require('@gitorch/cgc')

async function run() {
  const client = new KuzuClient(':memory:')
  await client.init()

  const manager = new TreeSitterManager()
  const indexer = new CodeGraphIndexer(client, manager)

  await indexer.initializeSchema()

  const code = `
    export function helloWorld() {
      return 'Hello, World!'
    }
  `

  await indexer.indexFile('src/hello.ts', code, 'typescript')
  console.log('Indexing completed!')

  await client.close()
}

run().catch(console.error)
```

---

## Roadmap

The project follows a risk-first roadmap:

- [x] **F0: Foundation** - Monorepo setup, Vitest, linting, and CI
- [x] **F1: CodeSight Core** - Tree-sitter WASM, SCIP export, and impact analysis
- [x] **F2: Cortex 4-Layer** - Layered memory retrieval with SQLite and ChromaDB
- [ ] **F3: Graph RAG Pipeline** - Semantic query processing
- [ ] **F4: Synapse + Pheromones** - Multi-agent coordination primitives
- [ ] **F5: GitHub Sync & Projects V2** - Backlog synchronization and integration
- [ ] **F6: Agents** - Integrated orchestration runtimes
- [ ] **F7: Workspace Engine** - Isolated test and build environments
- [ ] **F8: Control Plane API** - Fastify API gateway
- [ ] **F9: Mission Control Frontend** - Visual React dashboard
- [ ] **F10: Secrets Vault & Auth** - Client-side secret protection
- [ ] **F11: Observability & Hardening** - Auditability and telemetry

---

## Public Documentation

The public documentation set prepared for the GitHub Wiki lives in [`wiki/`](wiki/Home.md):

- [Home](wiki/Home.md)
- [Getting Started](wiki/Getting-Started.md)
- [Architecture Overview](wiki/Architecture-Overview.md)
- [CodeSight API](wiki/CodeSight-API.md)
- [Cortex API](wiki/Cortex-API.md)
- [Roadmap](wiki/Roadmap.md)

---

## Development Commands

```bash
pnpm dev
pnpm lint
pnpm test
pnpm build
```

---

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. See [LICENSE](LICENSE).
