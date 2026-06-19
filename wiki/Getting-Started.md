# Getting Started

This guide gets you from install to a working code graph index and a working Cortex memory store.

## Prerequisites

- Node.js 20+
- `pnpm`

## Install

```bash
pnpm install
```

## Quick Start: CodeSight

The `@gitorch/cgc` package indexes source files into a graph stored in KuzuDB.

```ts
import { CodeGraphIndexer, KuzuClient, TreeSitterManager } from '@gitorch/cgc'

async function main() {
  const client = new KuzuClient(':memory:')
  await client.init()

  const parser = new TreeSitterManager()
  const indexer = new CodeGraphIndexer(client, parser)

  await indexer.initializeSchema()
  await indexer.indexFile(
    'src/hello.ts',
    `
    export function helloWorld() {
      return 'Hello, world!'
    }
    `,
    'typescript'
  )

  await client.close()
}

main().catch(console.error)
```

## Quick Start: Cortex

The `@gitorch/cortex` package stores layered retrieval state in SQLite and ChromaDB-compatible collections.

```ts
import { CortexClient, deterministicEmbedding } from '@gitorch/cortex'

async function main() {
  const client = new CortexClient({
    sqlitePath: '.cortex.sqlite',
    embeddingFn: deterministicEmbedding,
  })

  client.init()

  client.writeIdentity({
    wingId: 'loureng/gitorch',
    persona: 'GitOrch Cortex',
    orchestrationGuidelines: 'Use L0-L3 retrieval.',
  })

  await client.writeDrawer({
    id: 'drawer-001',
    wingId: 'loureng/gitorch',
    roomId: 'auth',
    hallId: 'facts',
    content: 'Auth uses access and refresh tokens.',
    importance: 0.9,
    emotionalWeight: 0.6,
    createdAt: '2026-06-19T00:00:00.000Z',
    validFrom: '2026-06-19T00:00:00.000Z',
    confidence: 0.95,
    tags: ['auth', 'tokens'],
  })

  const wakeUp = client.wakeUp('loureng/gitorch')
  console.log(wakeUp.drawers.length)

  client.close()
}

main().catch(console.error)
```

## Validation Commands

```bash
pnpm test
pnpm build
pnpm lint
```

## Package-Level Commands

```bash
pnpm --filter @gitorch/cgc test
pnpm --filter @gitorch/cgc build
pnpm --filter @gitorch/cgc lint

pnpm --filter @gitorch/cortex test
pnpm --filter @gitorch/cortex build
pnpm --filter @gitorch/cortex lint
```
