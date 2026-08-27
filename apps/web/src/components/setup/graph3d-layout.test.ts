import { describe, it, expect } from 'vitest'
import {
  fibonacciSpherePositions,
  radiusForNodeCount,
  computeNodePositions,
  forceDirectedPositions,
  clusterKeyForFile,
  nodeRadiusForType,
  edgeOpacityForRel,
  edgeVisualOpacity,
  computeNodeDegrees,
  nodeImportanceScale,
  healthCssVar,
  parseAggregatedCount,
  isWebglAvailable,
  type Vec3,
} from './graph3d-layout'

function dist(a: Vec3, b: Vec3): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

describe('fibonacciSpherePositions', () => {
  it('devolve zero pontos pra zero nós, e a origem pra 1 nó', () => {
    expect(fibonacciSpherePositions(0, 10)).toEqual([])
    expect(fibonacciSpherePositions(1, 10)).toEqual([{ x: 0, y: 0, z: 0 }])
  })

  it('é determinístico — mesma entrada, mesma saída, sempre', () => {
    const a = fibonacciSpherePositions(50, 8)
    const b = fibonacciSpherePositions(50, 8)
    expect(a).toEqual(b)
  })

  it('todos os pontos ficam à distância ~radius da origem (na esfera)', () => {
    const radius = 12
    const points = fibonacciSpherePositions(200, radius)
    for (const p of points) {
      const d = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z)
      expect(d).toBeGreaterThan(radius - 0.001)
      expect(d).toBeLessThan(radius + 0.001)
    }
  })

  it('não repete a mesma posição pra nós diferentes', () => {
    const points = fibonacciSpherePositions(30, 5)
    const keys = new Set(points.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}`))
    expect(keys.size).toBe(30)
  })
})

describe('radiusForNodeCount', () => {
  it('cresce com a raiz do número de nós, nunca menor que o piso', () => {
    expect(radiusForNodeCount(0)).toBeGreaterThanOrEqual(4)
    expect(radiusForNodeCount(1)).toBeGreaterThanOrEqual(4)
    expect(radiusForNodeCount(400)).toBeGreaterThan(radiusForNodeCount(4))
  })
})

describe('computeNodePositions', () => {
  it('devolve uma posição por id, sem duplicar nem perder nó', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const positions = computeNodePositions(nodes)
    expect(positions.size).toBe(3)
    expect(positions.has('a')).toBe(true)
    expect(positions.has('b')).toBe(true)
    expect(positions.has('c')).toBe(true)
  })

  it('sem arestas, ainda devolve uma posição por nó (fallback do force-directed)', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }]
    const positions = computeNodePositions(nodes)
    expect(positions.size).toBe(2)
  })
})

describe('clusterKeyForFile', () => {
  it('agrupa pelos 2 primeiros segmentos do caminho (sem o nome do arquivo)', () => {
    expect(clusterKeyForFile('apps/web/src/components/setup/RepoGraph3D.tsx')).toBe('apps/web')
    expect(clusterKeyForFile('apps/control-plane/src/routes/diagnose.ts')).toBe(
      'apps/control-plane'
    )
  })

  it('arquivo na raiz (sem diretório) devolve chave vazia', () => {
    expect(clusterKeyForFile('README.md')).toBe('')
  })

  it('sem file, devolve chave vazia', () => {
    expect(clusterKeyForFile(undefined)).toBe('')
  })
})

describe('forceDirectedPositions', () => {
  it('é determinístico — mesma entrada, mesma saída, sempre', () => {
    const nodes = Array.from({ length: 24 }, (_, i) => ({ id: `n${i}`, file: `apps/web/f${i}.ts` }))
    const edges = [
      { source: 'n0', target: 'n1' },
      { source: 'n1', target: 'n2' },
      { source: 'n5', target: 'n6' },
    ]
    const a = forceDirectedPositions(nodes, edges)
    const b = forceDirectedPositions(nodes, edges)
    expect([...a.entries()]).toEqual([...b.entries()])
  })

  it('nós conectados por aresta terminam mais próximos que nós sem nenhuma aresta', () => {
    const nodes = Array.from({ length: 16 }, (_, i) => ({ id: `n${i}` }))
    // só n0-n1 tem aresta — o resto fica isolado (só repulsão + gravidade).
    const edges = [{ source: 'n0', target: 'n1' }]
    const positions = forceDirectedPositions(nodes, edges)
    const p0 = positions.get('n0')!
    const p1 = positions.get('n1')!
    const distConnected = dist(p0, p1)

    const unconnectedDistances = nodes.slice(2).map((n) => dist(p0, positions.get(n.id)!))
    const avgUnconnected =
      unconnectedDistances.reduce((s, d) => s + d, 0) / unconnectedDistances.length

    expect(distConnected).toBeLessThan(avgUnconnected)
  })

  it('nós do mesmo diretório (viés de agrupamento) terminam mais próximos entre si do que de nós de outro diretório, mesmo sem aresta nenhuma', () => {
    const groupA = Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, file: `apps/web/f${i}.ts` }))
    const groupB = Array.from({ length: 6 }, (_, i) => ({
      id: `b${i}`,
      file: `apps/control-plane/f${i}.ts`,
    }))
    const nodes = [...groupA, ...groupB]
    const positions = forceDirectedPositions(nodes, [])

    const avgDist = (ids: string[]): number => {
      const pairs: number[] = []
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          pairs.push(dist(positions.get(ids[i])!, positions.get(ids[j])!))
        }
      }
      return pairs.reduce((s, d) => s + d, 0) / pairs.length
    }
    const avgWithinA = avgDist(groupA.map((n) => n.id))
    const avgAtoB = (() => {
      const pairs: number[] = []
      for (const a of groupA)
        for (const b of groupB) pairs.push(dist(positions.get(a.id)!, positions.get(b.id)!))
      return pairs.reduce((s, d) => s + d, 0) / pairs.length
    })()

    expect(avgWithinA).toBeLessThan(avgAtoB)
  })

  it('nunca explode pro infinito — grafo totalmente desconectado fica contido perto do raio esperado', () => {
    const nodes = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}` }))
    const positions = forceDirectedPositions(nodes, [])
    const radius = radiusForNodeCount(nodes.length)
    for (const p of positions.values()) {
      const d = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z)
      expect(d).toBeLessThan(radius * 3)
    }
  })

  it('termina em tempo hábil mesmo perto do teto de 1500 nós (smoke de performance)', () => {
    const nodes = Array.from({ length: 1500 }, (_, i) => ({
      id: `n${i}`,
      file: `apps/web/f${i % 50}.ts`,
    }))
    const edges = Array.from({ length: 1400 }, (_, i) => ({ source: `n${i}`, target: `n${i + 1}` }))
    const start = performance.now()
    const positions = forceDirectedPositions(nodes, edges)
    const elapsed = performance.now() - start
    expect(positions.size).toBe(1500)
    expect(elapsed).toBeLessThan(15000)
  })

  it('zero nós devolve mapa vazio; 1 nó fica na origem', () => {
    expect(forceDirectedPositions([], []).size).toBe(0)
    expect(forceDirectedPositions([{ id: 'only' }], [])).toEqual(
      new Map([['only', { x: 0, y: 0, z: 0 }]])
    )
  })
})

describe('nodeRadiusForType', () => {
  it('diretório e classe/interface são maiores que função/variável', () => {
    expect(nodeRadiusForType('directory')).toBeGreaterThan(nodeRadiusForType('function'))
    expect(nodeRadiusForType('class')).toBeGreaterThan(nodeRadiusForType('variable'))
    expect(nodeRadiusForType('interface')).toBeGreaterThan(nodeRadiusForType('method'))
  })
})

describe('edgeOpacityForRel', () => {
  it('CALLS > IMPORTS > CONTAINS/default', () => {
    expect(edgeOpacityForRel('CALLS')).toBeGreaterThan(edgeOpacityForRel('IMPORTS'))
    expect(edgeOpacityForRel('IMPORTS')).toBeGreaterThan(edgeOpacityForRel('CONTAINS'))
    expect(edgeOpacityForRel('unknown')).toBe(edgeOpacityForRel('CONTAINS'))
  })
})

describe('edgeVisualOpacity', () => {
  it('mantém o ranking (CALLS > IMPORTS > CONTAINS) mas SEMPRE dentro da faixa sutil 0.15-0.25', () => {
    for (const rel of ['CALLS', 'IMPORTS', 'CONTAINS', 'unknown']) {
      const o = edgeVisualOpacity(rel)
      expect(o).toBeGreaterThanOrEqual(0.15)
      expect(o).toBeLessThanOrEqual(0.25)
    }
    expect(edgeVisualOpacity('CALLS')).toBeGreaterThan(edgeVisualOpacity('IMPORTS'))
    expect(edgeVisualOpacity('IMPORTS')).toBeGreaterThan(edgeVisualOpacity('CONTAINS'))
  })
})

describe('computeNodeDegrees', () => {
  it('soma origem + destino — nó em 3 arestas tem grau 3', () => {
    const edges = [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
      { source: 'd', target: 'a' },
    ]
    const degrees = computeNodeDegrees(edges)
    expect(degrees.get('a')).toBe(3)
    expect(degrees.get('b')).toBe(1)
    expect(degrees.get('c')).toBe(1)
    expect(degrees.get('d')).toBe(1)
  })

  it('nó sem nenhuma aresta não aparece no mapa (degree implícito 0)', () => {
    const degrees = computeNodeDegrees([{ source: 'a', target: 'b' }])
    expect(degrees.has('z')).toBe(false)
  })
})

describe('nodeImportanceScale', () => {
  it('grau 0 é a escala-base (1x); grau maior cresce, mas com teto (não deixa hub engolir a cena)', () => {
    expect(nodeImportanceScale(0)).toBe(1)
    expect(nodeImportanceScale(4)).toBeGreaterThan(nodeImportanceScale(0))
    expect(nodeImportanceScale(400)).toBeGreaterThan(nodeImportanceScale(4))
    expect(nodeImportanceScale(100000)).toBeLessThanOrEqual(2.5)
  })
})

describe('healthCssVar', () => {
  it('mapeia pros MESMOS tokens --gl-* já usados em wz-diag-finding/ficon', () => {
    expect(healthCssVar('good')).toBe('--gl-accent-ink')
    expect(healthCssVar('warn')).toBe('--gl-warn')
    expect(healthCssVar('bad')).toBe('--gl-sev')
  })
})

describe('parseAggregatedCount', () => {
  it('extrai o N de "dir (N)" (label do nó agregado por diretório)', () => {
    expect(parseAggregatedCount('src/components (42)')).toBe(42)
    expect(parseAggregatedCount('. (7)')).toBe(7)
  })

  it('devolve null pra label sem contagem (nó normal, não agregado)', () => {
    expect(parseAggregatedCount('somar')).toBeNull()
  })
})

describe('isWebglAvailable', () => {
  it('nunca lança fora do browser (sem document) — devolve false', () => {
    // vitest.config.ts roda apps/web em environment:'node' (sem jsdom) —
    // exatamente o cenário do passe de pré-render do `next build`
    // (output:'export'), que não pode quebrar por causa do grafo 3D.
    expect(typeof document).toBe('undefined')
    expect(isWebglAvailable()).toBe(false)
  })
})
