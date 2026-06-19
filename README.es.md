# 🐙 GitOrch — Plano de Control de Orquestación Multi-Agente

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)

[English](README.md) | [Português (PT-BR)](README.pt-br.md)

**GitOrch** es un plano de control (control plane) de orquestación multi-agente de alto rendimiento, diseñado para gobernar equipos coordinados de agentes de inteligencia artificial (Product Owner, Scrum Master, Requirements Analyst, Quality Assurance) que operan directamente sobre repositorios de GitHub.

Integra **CodeSight** para inteligencia estructural de código y **Cortex** para la retención de memoria semántica y espacial a largo plazo.

---

## 🚀 Inicio Rápido (CodeSight Core)

El paquete `@gitorch/codesight` (CGC) proporciona toda la inteligencia sintática y el motor de persistencia de grafos.

### Instalación

```bash
pnpm install
```

### Inicializando e Indexando el Código

```javascript
const { KuzuClient, TreeSitterManager, CodeGraphIndexer } = require('@gitorch/codesight');

async function run() {
  // Inicializa KuzuDB en memoria o en disco
  const client = new KuzuClient(':memory:');
  const manager = new TreeSitterManager();
  const indexer = new CodeGraphIndexer(client, manager);

  // Inicializa tablas y aristas
  await indexer.initializeSchema();

  // Indexa un archivo de código
  const code = `
    export function helloWorld() {
      return "Hello, World!";
    }
  `;
  await indexer.indexFile('src/hello.ts', code, 'typescript');
  console.log("¡Indexación completada!");
  
  await client.close();
}

run().catch(console.error);
```

---

## 🏗️ Roadmap del MVP

El proyecto sigue un ciclo de desarrollo ordenado por riesgo técnico (Risk-First) compuesto por 12 fases:

- [x] **Fase F0: Cimientos** — Configuración del monorepo, Vitest, linting y CI.
- [x] **Fase F1: CodeSight Core** — Tree-sitter WASM, exportación SCIP y análisis de impacto.
- [ ] **Fase F2: Cortex 4-Layer** — Capa de memoria espacial basada en SQLite + ChromaDB. *(Siguiente paso)*
- [ ] **Fase F3: Pipeline de Graph RAG** — Secuencia de procesamiento de consultas semánticas.
- [ ] **Fase F4: Synapse + Feromonas** — Orquestación estigmérgica de agentes.
- [ ] **Fase F5: Sincronización GitHub & Projects V2** — Sincronización de backlog e integraciones.
- [ ] **Fase F6: Agentes** — Runtimes de agentes integrados (PO, SM, RA, QA).
- [ ] **Fase F7: Workspace Engine** — Ejecución aislada de pruebas y entornos de compilación.
- [ ] **Fase F8: API del Plano de Control** — API Gateway con Fastify.
- [ ] **Fase F9: Frontend Mission Control** — Dashboard visual en React.
- [ ] **Fase F10: Secrets Vault & Autenticación** — Cifrado de claves del lado del cliente.
- [ ] **Fase F11: Observabilidad & Robustecimiento** — Auditoría de cumplimiento y telemetría.

---

## 📚 Documentación Oficial

Toda la documentación técnica para usuarios y la comunidad está alojada en la **Wiki de GitHub** de este repositorio. Haga clic en la pestaña **Wiki** en la parte superior de esta página en GitHub para acceder a guías como:

* **Guía de Inicio Rápido:** Primeros pasos indexando código con CodeSight.
* **Descripción General de la Arquitectura:** Cómo cooperan CodeSight y Cortex.
* **Manuales y Guías de Uso:** Consultando el grafo de código y configurando agentes.
* **Backlog y Roadmap:** Seguimiento detallado del desarrollo y nuevas funciones.

---

## 🛠️ Comandos de Desarrollo

```bash
# Ejecutar en desarrollo
pnpm dev

# Ejecutar linter
pnpm run lint

# Ejecutar pruebas unitarias
pnpm run test

# Compilar proyectos
pnpm run build
```

---

## 📄 Licencia

Este proyecto está bajo la licencia **GNU Affero General Public License v3.0 (AGPL-3.0)**. Consulte el archivo [LICENSE](LICENSE) para ver el texto completo.
