# Cortex API

`@gitorch/cortex` is the public package for the F2 layered memory system.

## Main Exports

### `CortexClient`

Entry point for writing and retrieving layered memory state.

Key methods:

- `init()`
- `writeIdentity(identity)`
- `writeDrawer(drawer)`
- `writeTriple(triple)`
- `wakeUp(wingId)`
- `recallLocal(wingId, roomId?, hallId?)`
- `search(wingId, query, limit)`
- `close()`

### `LayerSelector`

Encapsulates layer selection and wake-up / recall policies.

Key methods:

- `wakeUp(wingId)`
- `loadL1(wingId)`
- `loadL2(wingId, roomId?, hallId?, limit?)`
- `selectLayer(intent)`

### `SqliteStore`

SQLite-backed persistence for identities, drawers, and temporal triples.

Key methods:

- `init()`
- `upsertIdentity(identity)`
- `getIdentity(wingId)`
- `upsertDrawer(drawer)`
- `getTopDrawers(wingId, limit)`
- `getDrawersByScope(wingId, roomId?, hallId?, limit?)`
- `insertTriple(triple)`
- `queryTriples(query)`
- `close()`

### `ChromaSemanticStore`

ChromaDB-compatible semantic storage for L3 retrieval.

Key methods:

- `fromOptions(options?)`
- `upsertDrawer(drawer, embeddings)`
- `search(wingId, roomId, hallId, queryEmbedding, limit)`

### `AakCodec`

Deterministic codec for compact drawer transport.

Key methods:

- `encode(input)`
- `decode(encoded)`
- `fromDrawer(drawer)`
- `toDrawer(encoded)`

### `deterministicEmbedding`

Fallback embedding generator used when no external embedding pipeline is provided.

## Core Data Types

Important exported types include:

- `CortexIdentity`
- `CortexDrawer`
- `CortexTriple`
- `CortexWakeUpResult`
- `CortexSearchResult`
- `CortexClientOptions`

## Minimal Example

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
    orchestrationGuidelines: 'Use layered retrieval.',
  })

  await client.writeDrawer({
    id: 'drawer-payments-001',
    wingId: 'loureng/gitorch',
    roomId: 'payments',
    hallId: 'facts',
    content: 'Stripe integration handles subscription billing.',
    importance: 0.95,
    emotionalWeight: 0.8,
    createdAt: '2026-06-19T00:00:00.000Z',
    validFrom: '2026-06-19T00:00:00.000Z',
    confidence: 0.97,
    tags: ['stripe', 'billing'],
  })

  const wakeUp = client.wakeUp('loureng/gitorch')
  const local = client.recallLocal('loureng/gitorch', 'payments', 'facts')
  const semantic = await client.search('loureng/gitorch', 'subscription billing', 5)

  console.log({ wakeUp, local, semantic })
  client.close()
}

main().catch(console.error)
```
