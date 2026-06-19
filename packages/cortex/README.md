# @gitorch/cortex

`@gitorch/cortex` is the F2 Cortex 4-Layer memory package for GitOrch.

It implements the official product direction from `docs/product` and `docs/superpowers`:

- L0 identity invariants;
- L1 wake-up from top priority drawers;
- L2 local recall by wing/room/hall;
- L3 semantic search through ChromaDB;
- SQLite temporal knowledge graph;
- AAAK deterministic compression.

## Usage

```ts
import { CortexClient, deterministicEmbedding } from '@gitorch/cortex'

const client = new CortexClient({
  sqlitePath: '.cortex.sqlite',
  embeddingFn: deterministicEmbedding,
})

client.init()

client.writeIdentity({
  wingId: 'loureng/gitorch',
  persona: 'GitOrch Cortex Orchestrator',
  orchestrationGuidelines: 'Use MemPalace isolation and L0-L3 retrieval.',
})

client.writeDrawer({
  id: 'drawer-auth-001',
  wingId: 'loureng/gitorch',
  roomId: 'auth_module',
  hallId: 'hall_facts',
  content: 'Auth module uses JWT access tokens and refresh tokens.',
  importance: 0.9,
  emotionalWeight: 0.7,
  createdAt: '2026-06-19T00:00:00.000Z',
  validFrom: '2026-06-19T00:00:00.000Z',
  confidence: 0.95,
  tags: ['auth', 'jwt'],
})

const wakeUp = client.wakeUp('loureng/gitorch')
const local = client.recallLocal('loureng/gitorch', 'auth_module', 'hall_facts')
const semantic = await client.search('loureng/gitorch', 'JWT refresh tokens', 5)

client.close()

console.log({ wakeUp, local, semantic })
```

## Development

```bash
pnpm --filter @gitorch/cortex test
pnpm --filter @gitorch/cortex lint
pnpm --filter @gitorch/cortex build
```

## Architecture

```text
CortexClient
├── LayerSelector
│   ├── L0 identity
│   ├── L1 wake-up
│   └── L2 local recall
├── SqliteStore
│   ├── cortex_identities
│   ├── cortex_drawers
│   └── cortex_triples
├── ChromaSemanticStore
│   └── L3 semantic drawers
└── AakCodec
    └── deterministic AAAK compression
```

## Notes

- `Diaries` are not part of Cortex.
- Temporal facts belong in SQLite triples with `valid_from` and `valid_to`.
- Semantic drawers belong in ChromaDB with wing/room/hall metadata.
- `wingId` is required for project isolation.
- `docs/product` and `docs/superpowers` are the official GitOrch docs; other docs are legacy.
