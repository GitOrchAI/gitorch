import { describe, it, expect } from 'vitest'
import {
  fibonacciSpherePositions,
  radiusForNodeCount,
  computeNodePositions,
  nodeRadiusForType,
  edgeOpacityForRel,
  healthCssVar,
  parseAggregatedCount,
  isWebglAvailable,
} from './graph3d-layout'

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
