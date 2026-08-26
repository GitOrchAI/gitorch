/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { KuzuClient } from '../db/kuzu-client'

describe('KuzuClient', () => {
  let client: KuzuClient

  beforeAll(() => {
    client = new KuzuClient(':memory:')
  })

  // `close()` devolve promessa e fecha um banco NATIVO. Sem o await, o fork do
  // vitest terminava enquanto o fechamento ainda estava em curso, e o addon
  // nativo derrubava o processo: "Worker exited unexpectedly" com os 37 testes
  // passando. Intermitente, e por isso lido como flaky por varias rodadas —
  // reprovou o CI de tres PRs diferentes em 25 e 26/08.
  afterAll(async () => {
    await client.close()
  })

  it('should connect to in-memory database', () => {
    expect(client).toBeDefined()
    expect(client).toBeInstanceOf(KuzuClient)
  })

  it('should execute CREATE TABLE and query', async () => {
    await client.execute('CREATE NODE TABLE TestNode(name STRING, value INT64, PRIMARY KEY (name))')
    await client.execute("CREATE (n:TestNode {name: 'test', value: 42})")

    const results = await client.query('MATCH (n:TestNode) RETURN n.name AS name, n.value AS value')
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe('test')
    expect(results[0].value).toBe(42)
  })

  it('should execute parameterized queries', async () => {
    await client.execute('CREATE (n:TestNode {name: $name, value: 100})', {
      name: 'param-test',
    })

    const results = await client.query('MATCH (n:TestNode) RETURN n.name AS name, n.value AS value')
    const match = results.find((r: any) => r.name === 'param-test')
    expect(match).toBeDefined()
    expect(match.value).toBe(100)
  })

  it('should handle multiple queries', async () => {
    await client.execute("CREATE (n:TestNode {name: 'multi1', value: 1})")
    await client.execute("CREATE (n:TestNode {name: 'multi2', value: 2})")
    await client.execute("CREATE (n:TestNode {name: 'multi3', value: 3})")

    const results = await client.query(
      'MATCH (n:TestNode) RETURN n.value AS value ORDER BY n.value'
    )
    expect(results).toHaveLength(5) // 1 from beforeAll + 1 param + 3 new
    expect(results.map((r: any) => r.value)).toEqual([1, 2, 3, 42, 100])
  })

  it('should close connection properly', async () => {
    const newClient = new KuzuClient(':memory:')
    await newClient.close()
    // O await tambem faz o teste provar o que promete: sem ele, uma falha
    // dentro do fechamento viraria rejeicao nao capturada, e o teste passaria
    // do mesmo jeito.
    expect(newClient.isClosed()).toBe(true)
  })
})
