# GitOrch - Plano de Control de Orquestacion Multi-Agente

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)

[English](README.md) | [Portuguese (PT-BR)](README.pt-br.md)

**GitOrch** es un plano de control de orquestacion multi-agente para flujos de ingenieria sobre repositorios GitHub.

Hoy entrega cuatro bloques principales:

- **CodeSight** para inteligencia estructural de codigo, indexacion, analisis de impacto y exportacion SCIP
- **Cortex** para recuperacion de memoria por capas con SQLite y ChromaDB
- **Graph RAG** para recuperacion y ranking deterministico sobre codigo y memoria
- **Synapse** para memoria de ejecucion, feromonas, claims, decision briefs y persistencia en Cortex

---

## Inicio Rapido (CodeSight Core)

El paquete `@gitorch/cgc` proporciona el motor de indexacion de grafos.

### Instalacion

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
  console.log('Indexacion completada!')

  await client.close()
}

run().catch(console.error)
```

---

## Roadmap

El proyecto sigue un roadmap orientado por riesgo:

- [x] **F0: Cimientos** - Configuracion del monorepo, Vitest, linting y CI
- [x] **F1: CodeSight Core** - Tree-sitter WASM, exportacion SCIP y analisis de impacto
- [x] **F2: Cortex 4-Layer** - Recuperacion de memoria por capas con SQLite y ChromaDB
- [x] **F3: Graph RAG Pipeline** - Procesamiento de consultas semanticas
- [x] **F4: Synapse + Feromonas** - Primitivas de coordinacion multi-agente
- [ ] **F5: GitHub Sync & Projects V2** - Sincronizacion de backlog e integraciones
- [ ] **F6: Agentes** - Runtimes integrados
- [ ] **F7: Workspace Engine** - Entornos aislados de prueba y build
- [ ] **F8: Control Plane API** - API gateway con Fastify
- [ ] **F9: Mission Control Frontend** - Dashboard visual en React
- [ ] **F10: Secrets Vault & Auth** - Proteccion client-side de secretos
- [ ] **F11: Observability & Hardening** - Auditabilidad y telemetria

---

## Documentacion Publica

El conjunto de documentacion publica preparado para la GitHub Wiki esta en [`wiki/`](wiki/Home.md):

- [Home](wiki/Home.md)
- [Getting Started](wiki/Getting-Started.md)
- [Architecture Overview](wiki/Architecture-Overview.md)
- [CodeSight API](wiki/CodeSight-API.md)
- [Cortex API](wiki/Cortex-API.md)
- [Roadmap](wiki/Roadmap.md)

---

## Comandos de Desarrollo

```bash
pnpm dev
pnpm lint
pnpm test
pnpm build
```

---

## Licencia

Este proyecto usa la **GNU Affero General Public License v3.0 (AGPL-3.0)**. Consulte [LICENSE](LICENSE).
