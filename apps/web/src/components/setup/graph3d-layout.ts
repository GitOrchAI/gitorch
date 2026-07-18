// Lógica pura do grafo 3D do diagnóstico (F1 — Onda 3): layout, tamanho e
// opacidade por tipo/saúde, e o parsing do rótulo agregado por diretório.
// Separado de RepoGraph3D.tsx (que só existe no browser — Canvas/WebGL) para
// poder ter TDD normal em Node, no mesmo padrão do resto do repo (apps/web
// só roda `*.test.ts`, nunca `*.test.tsx` — ver vitest.config.ts).

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface GraphNodeLike {
  id: string
  file: string
  type: string
}

/**
 * Layout determinístico calculado 1x (nunca por frame — ver mini-spec):
 * espiral de Fibonacci numa esfera. Determinístico pela ORDEM do array de
 * entrada (mesma entrada -> mesma saída sempre), sem física/simulação.
 */
export function fibonacciSpherePositions(count: number, radius: number): Vec3[] {
  if (count <= 0) return []
  if (count === 1) return [{ x: 0, y: 0, z: 0 }]

  const points: Vec3[] = []
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2 // de 1 a -1
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = goldenAngle * i
    points.push({ x: Math.cos(theta) * r * radius, y: y * radius, z: Math.sin(theta) * r * radius })
  }
  return points
}

/** Raio da esfera cresce com a raiz do número de nós — grafos maiores
 * espalham mais, mas sem crescer linear (ficaria vazio demais no centro). */
export function radiusForNodeCount(count: number): number {
  return Math.max(4, Math.sqrt(Math.max(1, count)) * 1.8)
}

export function computeNodePositions<T extends { id: string }>(nodes: T[]): Map<string, Vec3> {
  const radius = radiusForNodeCount(nodes.length)
  const positions = fibonacciSpherePositions(nodes.length, radius)
  const map = new Map<string, Vec3>()
  nodes.forEach((n, i) => {
    const p = positions[i]
    if (p) map.set(n.id, p)
  })
  return map
}

/** Formas por tipo: só o TAMANHO varia (cor é sempre saúde — mini-spec). */
export function nodeRadiusForType(type: string): number {
  if (type === 'directory') return 0.32
  if (type === 'class' || type === 'interface') return 0.22
  if (type === 'function' || type === 'method') return 0.15
  return 0.11
}

/** CALLS é a relação mais "forte" visualmente; CONTAINS é só estrutura. */
export function edgeOpacityForRel(rel: string): number {
  if (rel === 'CALLS') return 0.85
  if (rel === 'IMPORTS') return 0.45
  return 0.3
}

/** Nome do token CSS (`--gl-*`) pra cor de saúde — resolvido de verdade via
 * getComputedStyle no componente (RepoGraph3D lê o valor real, tema-aware). */
export function healthCssVar(health: 'good' | 'warn' | 'bad'): string {
  if (health === 'good') return '--gl-accent-ink'
  if (health === 'warn') return '--gl-warn'
  return '--gl-sev'
}

/** Nó agregado por diretório tem label "`<dir> (<N>)`" (export-graph.ts no
 * CGC) — extrai o N pra interpolar em diagGraphPanelDirectory. */
export function parseAggregatedCount(label: string): number | null {
  const m = /\((\d+)\)\s*$/.exec(label)
  return m?.[1] ? Number(m[1]) : null
}

/** Guarda de suporte: `next build` (output:'export') faz um passe de
 * pré-render em Node — sem `document`/WebGL — então esta checagem NUNCA pode
 * lançar fora do browser. Repo sem WebGL cai pro fallback em tabela
 * (StepDiagnosis nem monta o Canvas). */
export function isWebglAvailable(): boolean {
  if (typeof document === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    return !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
  } catch {
    return false
  }
}
