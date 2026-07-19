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

export interface ForceEdgeLike {
  source: string
  target: string
}

export interface ForceNodeLike {
  id: string
  /** Opcional: usado só pro leve viés de agrupamento por diretório
   * (`clusterKeyForFile`). Sem `file`, o nó só sofre repulsão/gravidade. */
  file?: string
}

interface ForceLayoutOptions {
  /** Nº de passos da simulação. Se omitido, `iterationsForNodeCount` decide
   * pelo tamanho do grafo — ver comentário no orçamento abaixo. */
  iterations?: number
}

// Repulsão é O(n²) por iteração (aceito até 1500 nós — mini-spec). Rodar um
// nº FIXO de iterações pra 1500 nós travaria a aba por vários segundos, então
// o Nº de iterações cai conforme n cresce, mantendo o trabalho total
// (aprox. iterations * n²) dentro de um orçamento fixo. Pra grafos pequenos
// (a maioria dos repos reais — ~176 nós no patinhas) isso ainda dá dezenas de
// iterações, layout bem relaxado.
const ITERATION_WORK_BUDGET = 6_000_000
const MIN_ITERATIONS = 24
const MAX_ITERATIONS = 200

function iterationsForNodeCount(n: number): number {
  if (n <= 1) return 0
  const raw = Math.round(ITERATION_WORK_BUDGET / (n * n))
  return Math.min(MAX_ITERATIONS, Math.max(MIN_ITERATIONS, raw))
}

const MIN_DISTANCE = 0.05 // piso pra evitar divisão por zero / força infinita
// Gravidade pro centro: sem ela, um grafo SEM nenhuma aresta (só repulsão)
// se espalharia pro infinito — nada segura ninguém perto de nada. Valor
// calibrado (ver script de tuning na PR) pra manter a nuvem dentro de ~1.4x
// o raio esperado mesmo no pior caso (grafo 100% desconectado).
const GRAVITY_STRENGTH = 0.4
// Viés de agrupamento por diretório: mais fraco que a mola de uma aresta
// real (CALLS/IMPORTS) — só "arruma a casa" quando não há estrutura nenhuma
// puxando o nó pra outro lugar.
const CLUSTER_STRENGTH = 0.06

function vecSub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}
function vecAdd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}
function vecScale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s }
}
function vecLen(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
}

/** Direção de escape determinística quando dois nós colidem quase no mesmo
 * ponto (distância ~0). Não usa `Math.random` — a simulação inteira precisa
 * continuar determinística (mesma entrada -> mesma saída, sempre). */
function deterministicJitterDirection(seed: number): Vec3 {
  const x = Math.sin(seed * 12.9898)
  const y = Math.sin(seed * 78.233)
  const z = Math.cos(seed * 37.719)
  const len = Math.sqrt(x * x + y * y + z * z) || 1
  return { x: x / len, y: y / len, z: z / len }
}

/** Chave de agrupamento "grosseira" de um arquivo: os 2 primeiros segmentos
 * do caminho, sem o nome do arquivo (ex. "apps/web/src/.../Foo.tsx" ->
 * "apps/web"). Granularidade de propósito grosseira — por pasta-folha quase
 * todo grupo teria 1 nó só e o viés não faria nada visualmente. Nós sem
 * diretório (arquivo na raiz) ou sem `file` não entram em grupo nenhum. */
export function clusterKeyForFile(file: string | undefined): string {
  if (!file) return ''
  const segments = file.split('/').slice(0, -1)
  if (segments.length === 0) return ''
  return segments.slice(0, 2).join('/')
}

/**
 * Layout força-dirigido em 3D (Fruchterman-Reingold adaptado): repulsão de
 * Coulomb entre todo par de nós + atração de Hooke ao longo das arestas +
 * leve gravidade central + leve viés de agrupamento por diretório
 * (`clusterKeyForFile`, usado quando não há `community` vindo da API — ver
 * mini-spec). Nós conectados (e do mesmo diretório) terminam próximos;
 * isolados se afastam. Roda 1x no cálculo (nunca por frame — o componente
 * chama isto dentro de `useMemo`). Determinístico: a posição inicial vem de
 * `fibonacciSpherePositions` (determinística pela ORDEM do array de nós) e a
 * simulação em si nunca usa `Math.random`.
 */
export function forceDirectedPositions<T extends ForceNodeLike>(
  nodes: T[],
  edges: ForceEdgeLike[],
  options: ForceLayoutOptions = {}
): Map<string, Vec3> {
  const n = nodes.length
  if (n === 0) return new Map()
  if (n === 1) return new Map([[nodes[0]!.id, { x: 0, y: 0, z: 0 }]])

  const radius = radiusForNodeCount(n)
  // "k" do Fruchterman-Reingold: distância de equilíbrio entre um par
  // repelindo-se e uma mola de aresta puxando — cresce com o raio da nuvem e
  // encolhe com a densidade de nós.
  const idealLength = Math.max(0.6, (radius * 1.4) / Math.sqrt(n))
  const iterations = options.iterations ?? iterationsForNodeCount(n)

  const indexOf = new Map(nodes.map((node, i) => [node.id, i]))
  const seed = fibonacciSpherePositions(n, radius)
  const pos: Vec3[] = seed.map((p) => ({ ...p }))

  const groupKeys = nodes.map((node) => clusterKeyForFile(node.file))
  const groupIndexOf = new Map<string, number>()
  for (const key of groupKeys) {
    if (key && !groupIndexOf.has(key)) groupIndexOf.set(key, groupIndexOf.size)
  }
  const groupOf: number[] = groupKeys.map((key) => (key ? (groupIndexOf.get(key) ?? -1) : -1))
  const groupCount = groupIndexOf.size

  const validEdges: Array<{ a: number; b: number }> = []
  for (const e of edges) {
    const a = indexOf.get(e.source)
    const b = indexOf.get(e.target)
    if (a !== undefined && b !== undefined && a !== b) validEdges.push({ a, b })
  }

  for (let iter = 0; iter < iterations; iter++) {
    const disp: Vec3[] = Array.from({ length: n }, () => ({ x: 0, y: 0, z: 0 }))

    // Repulsão (Coulomb) — todo par de nós, O(n²) (aceito até 1500 nós).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let delta = vecSub(pos[i]!, pos[j]!)
        let d = vecLen(delta)
        if (d < MIN_DISTANCE) {
          delta = deterministicJitterDirection(i * 7919 + j * 104729 + 1)
          d = MIN_DISTANCE
        }
        const force = (idealLength * idealLength) / d
        const dir = vecScale(delta, force / d)
        disp[i] = vecAdd(disp[i]!, dir)
        disp[j] = vecSub(disp[j]!, dir)
      }
    }

    // Atração (Hooke) — só ao longo das arestas reais do grafo.
    for (const { a, b } of validEdges) {
      const delta = vecSub(pos[a]!, pos[b]!)
      const d = Math.max(MIN_DISTANCE, vecLen(delta))
      const force = (d * d) / idealLength
      const dir = vecScale(delta, force / d)
      disp[a] = vecSub(disp[a]!, dir)
      disp[b] = vecAdd(disp[b]!, dir)
    }

    // Gravidade — puxa levemente pro centro.
    for (let i = 0; i < n; i++) {
      disp[i] = vecSub(disp[i]!, vecScale(pos[i]!, GRAVITY_STRENGTH))
    }

    // Viés de agrupamento por diretório — puxa levemente pro centroide do
    // próprio grupo (via centroide: O(n), não O(n²) dentro do grupo).
    if (groupCount > 0) {
      const centroids: Vec3[] = Array.from({ length: groupCount }, () => ({ x: 0, y: 0, z: 0 }))
      const counts: number[] = new Array(groupCount).fill(0)
      for (let i = 0; i < n; i++) {
        const g = groupOf[i]!
        if (g < 0) continue
        centroids[g] = vecAdd(centroids[g]!, pos[i]!)
        counts[g]++
      }
      for (let g = 0; g < groupCount; g++) {
        if (counts[g]! > 1) centroids[g] = vecScale(centroids[g]!, 1 / counts[g]!)
      }
      for (let i = 0; i < n; i++) {
        const g = groupOf[i]!
        if (g < 0 || counts[g]! <= 1) continue
        const toCentroid = vecSub(centroids[g]!, pos[i]!)
        disp[i] = vecAdd(disp[i]!, vecScale(toCentroid, CLUSTER_STRENGTH))
      }
    }

    // Resfriamento (Fruchterman-Reingold): limita o deslocamento máximo por
    // nó nesta iteração, decrescendo linearmente até ~0 — o layout converge
    // em vez de oscilar pra sempre.
    const temperature = Math.max(radius * 0.12 * (1 - iter / iterations), 0.001)
    for (let i = 0; i < n; i++) {
      const d = vecLen(disp[i]!)
      if (d > 0) {
        const capped = Math.min(d, temperature)
        pos[i] = vecAdd(pos[i]!, vecScale(disp[i]!, capped / d))
      }
    }
  }

  const result = new Map<string, Vec3>()
  nodes.forEach((node, i) => result.set(node.id, pos[i]!))
  return result
}

export function computeNodePositions<T extends ForceNodeLike>(
  nodes: T[],
  edges: ForceEdgeLike[] = []
): Map<string, Vec3> {
  return forceDirectedPositions(nodes, edges)
}

/** Formas por tipo: só o TAMANHO varia (cor é sempre saúde — mini-spec). */
export function nodeRadiusForType(type: string): number {
  if (type === 'directory') return 0.32
  if (type === 'class' || type === 'interface') return 0.22
  if (type === 'function' || type === 'method') return 0.15
  return 0.11
}

/** CALLS é a relação mais "forte" visualmente; CONTAINS é só estrutura.
 * Ranking semântico bruto — pra opacidade REAL na tela, ver
 * `edgeVisualOpacity` (comprime isto numa faixa bem mais sutil). */
export function edgeOpacityForRel(rel: string): number {
  if (rel === 'CALLS') return 0.85
  if (rel === 'IMPORTS') return 0.45
  return 0.3
}

const EDGE_VISUAL_OPACITY_FLOOR = 0.15
const EDGE_VISUAL_OPACITY_CEIL = 0.25
const EDGE_OPACITY_FOR_REL_MIN = 0.3 // = edgeOpacityForRel('CONTAINS'/default)
const EDGE_OPACITY_FOR_REL_MAX = 0.85 // = edgeOpacityForRel('CALLS')

/** Opacidade REAL da aresta na tela — sempre entre 0.15 e 0.25. Arestas
 * fortes demais é o motivo do grafo antigo (esfera) parecer um "novelo de
 * linhas"; mantém o RANKING de `edgeOpacityForRel` (CALLS mais visível que
 * CONTAINS) mas nunca deixa nenhuma aresta competir com os nós. */
export function edgeVisualOpacity(rel: string): number {
  const raw = edgeOpacityForRel(rel)
  const normalized =
    (raw - EDGE_OPACITY_FOR_REL_MIN) / (EDGE_OPACITY_FOR_REL_MAX - EDGE_OPACITY_FOR_REL_MIN)
  return (
    EDGE_VISUAL_OPACITY_FLOOR + normalized * (EDGE_VISUAL_OPACITY_CEIL - EDGE_VISUAL_OPACITY_FLOOR)
  )
}

/** Grau de cada nó (Nº de arestas em que aparece, origem ou destino) — proxy
 * de "importância" sem precisar de nenhum dado novo da API: um nó muito
 * chamado/muito importado naturalmente acumula mais arestas. Nó ausente do
 * mapa = grau 0 (não apareceu em nenhuma aresta). */
export function computeNodeDegrees(edges: ForceEdgeLike[]): Map<string, number> {
  const degrees = new Map<string, number>()
  for (const e of edges) {
    degrees.set(e.source, (degrees.get(e.source) ?? 0) + 1)
    degrees.set(e.target, (degrees.get(e.target) ?? 0) + 1)
  }
  return degrees
}

/** Escala de tamanho por importância (grau) — cresce com a raiz do grau
 * (sqrt amortece outliers: um hub com 500 conexões não pode ficar 500x
 * maior que uma folha) e tem teto (2.5x) pra manter o grafo legível. */
export function nodeImportanceScale(degree: number): number {
  return Math.min(2.5, 1 + Math.sqrt(Math.max(0, degree)) * 0.22)
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
