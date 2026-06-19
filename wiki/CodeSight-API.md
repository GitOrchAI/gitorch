# CodeSight API

`@gitorch/cgc` is the public package for structural code intelligence.

## Main Exports

### `KuzuClient`

Wrapper around KuzuDB connection management and query execution.

Key methods:

- `init()`
- `execute(query, parameters?)`
- `query(query, options?)`
- `createNodeTable(label, properties, primaryKey?)`
- `createRelTable(label, from, to, properties?)`
- `close()`

### `TreeSitterManager`

Parser manager built on `@kreuzberg/tree-sitter-language-pack-wasm`.

Key methods:

- `parseString(code, language)`
- `parseFile(filePath)`
- `getParser(language)`
- `getSupportedLanguages()`
- `getSupportedExtensions()`

Current language map includes:

- TypeScript / JavaScript
- TSX / JSX
- Python
- Go
- Rust

### `CodeGraphIndexer`

Builds the code graph in KuzuDB.

Key methods:

- `initializeSchema()`
- `indexFile(filePath, content, language)`

The schema creates:

- `File` nodes
- `Symbol` nodes
- `CONTAINS` relationships
- `CALLS` relationships
- `IMPORTS` relationships

### `ImpactAnalyzer`

Traverses `CALLS` and `IMPORTS` edges to compute affected symbols.

Key method:

- `analyzeImpact(symbolId, maxDepth?)`

Return shape:

- `symbolId`
- `name`
- `filePath`
- `type`
- `depth`

### `ScipExporter`

Exports indexed graph data as SCIP-like documents.

Key method:

- `export({ projectRoot? })`

## Minimal Example

```ts
import {
  CodeGraphIndexer,
  ImpactAnalyzer,
  KuzuClient,
  ScipExporter,
  TreeSitterManager,
} from '@gitorch/cgc'

async function main() {
  const client = new KuzuClient(':memory:')
  await client.init()

  const parser = new TreeSitterManager()
  const indexer = new CodeGraphIndexer(client, parser)
  await indexer.initializeSchema()

  await indexer.indexFile(
    'src/math.ts',
    `
    export function sum(a, b) {
      return a + b
    }
    `,
    'typescript'
  )

  const impact = new ImpactAnalyzer(client)
  const exporter = new ScipExporter(client)

  console.log(await impact.analyzeImpact('cgc://src/math.ts#sum'))
  console.log(await exporter.export({ projectRoot: 'src/' }))

  await client.close()
}

main().catch(console.error)
```
