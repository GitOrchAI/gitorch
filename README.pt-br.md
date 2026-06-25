# GitOrch - Plano de Controle de Orquestracao Multi-Agente

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)

[English](README.md) | [Spanish (ES)](README.es.md)

**GitOrch** e um plano de controle de orquestracao multi-agente para fluxos de engenharia em repositorios GitHub.

Hoje ele entrega cinco blocos principais:

- **CodeSight** para inteligencia estrutural de codigo, indexacao, analise de impacto e exportacao SCIP
- **Cortex** para recuperacao de memoria em camadas com SQLite e ChromaDB
- **Graph RAG** para recuperacao e ranqueamento deterministico sobre codigo e memoria
- **Synapse** para memoria de execucao, feromonios, claims, decision briefs e persistencia no Cortex
- **GitHub Sync** para issue types, sub-issues, dependencias, operacoes Projects V2, normalizacao de webhooks e eventos Synapse

---

## Inicio Rapido (CodeSight Core)

O pacote `@gitorch/cgc` fornece o motor de indexacao de grafo.

### Instalacao

```bash
pnpm install
```

### Inicializar e Indexar Codigo

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
  console.log('Indexacao concluida!')

  await client.close()
}

run().catch(console.error)
```

---

## Roadmap

O projeto segue um roadmap orientado a risco:

- [x] **F0: Fundacoes** - Setup do monorepo, Vitest, linting e CI
- [x] **F1: CodeSight Core** - Tree-sitter WASM, exportacao SCIP e analise de impacto
- [x] **F2: Cortex 4-Layer** - Recuperacao de memoria em camadas com SQLite e ChromaDB
- [x] **F3: Graph RAG Pipeline** - Processamento de consultas semanticas
- [x] **F4: Synapse + Feromonios** - Primitivas de coordenacao multi-agente
- [x] **F5: GitHub Sync & Projects V2** - Sincronizacao GitHub-native de backlog, webhooks, hierarquia, dependencias e operacoes Projects V2
- [x] **F6: Agentes** - Orquestracao backend de runtimes para PO, RA, SM, QA, reconhecimento de projeto, gates Jules e missoes independentes de runtime
- [ ] **F7: Workspace Engine** - Ambientes isolados de teste e build
- [ ] **F8: Control Plane API** - API gateway com Fastify
- [ ] **F9: Mission Control Frontend** - Dashboard visual em React
- [ ] **F10: Secrets Vault & Auth** - Protecao client-side de segredos
- [ ] **F11: Observability & Hardening** - Auditabilidade e telemetria

---

## Documentacao Publica

O conjunto de documentacao publica preparado para a GitHub Wiki esta em [`wiki/`](wiki/Home.md):

- [Home](wiki/Home.md)
- [Getting Started](wiki/Getting-Started.md)
- [Architecture Overview](wiki/Architecture-Overview.md)
- [CodeSight API](wiki/CodeSight-API.md)
- [Cortex API](wiki/Cortex-API.md)
- [Roadmap](wiki/Roadmap.md)

---

## Comandos de Desenvolvimento

```bash
pnpm dev
pnpm lint
pnpm test
pnpm build
```

---

## Licenca

Este projeto usa a **GNU Affero General Public License v3.0 (AGPL-3.0)**. Veja [LICENSE](LICENSE).
