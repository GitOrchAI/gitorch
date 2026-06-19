import { describe, expect, it } from 'vitest'

describe('@gitorch/cortex package smoke', () => {
  it('exports the public Cortex API', async () => {
    const cortex = await import('./index')

    expect(cortex).toHaveProperty('CortexClient')
    expect(cortex).toHaveProperty('deterministicEmbedding')
    expect(cortex).toHaveProperty('AakCodec')
    expect(cortex).toHaveProperty('LayerSelector')
    expect(cortex).toHaveProperty('SqliteStore')
    expect(cortex).toHaveProperty('ChromaSemanticStore')
  })
})
