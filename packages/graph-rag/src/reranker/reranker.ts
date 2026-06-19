import type { ExpandedSubgraph, GraphNode, GraphRAGPlan, RankedFile } from '../types'

const DEFAULT_SCORE_THRESHOLD = 0.75
const DEFAULT_CONTEXT_BUDGET_RATIO = 0.7
const DEFAULT_TOTAL_WINDOW_TOKENS = 128000

const CAMEL_CASE_BOUNDARY_REGEX = /([a-z0-9])([A-Z])/g
const WORD_REGEX = /[A-Za-z0-9_]+/g
const PATH_SEPARATOR_REGEX = /[\\/]+/g

export interface DynamicBudgetRerankerOptions {
  scoreThreshold?: number
  contextBudgetRatio?: number
  totalWindowTokens?: number
}

export interface RankScore {
  score: number
  reasons: string[]
}

type RankedFileWithScores = RankedFile & {
  fileNameScore: number
  skeletonScore: number
}

type FileGroup = {
  filePath: string
  nodes: GraphNode[]
}

type TextMatchField = {
  name: string
  value: string | undefined
  weight: number
}

type TextMatch = {
  score: number
  reason: string
}

export class FileNameRanker {
  score(node: Pick<GraphNode, 'filePath'>, plan: GraphRAGPlan): number {
    return this.scoreWithReasons(node, plan).score
  }

  scoreWithReasons(node: Pick<GraphNode, 'filePath'>, plan: GraphRAGPlan): RankScore {
    if (!node.filePath) {
      return { score: 0, reasons: [] }
    }

    const terms = uniqueStrings([...plan.extractor.entities, ...plan.extractor.keywords])
    const normalizedPath = normalizePath(node.filePath)
    const pathSegments = normalizedPath.split('/').filter(Boolean)
    const basename = pathSegments[pathSegments.length - 1]
    const stem = basename ? stripKnownExtension(basename) : ''
    const matches: TextMatch[] = []

    for (const term of terms) {
      const normalizedTerm = normalizeSearchTerm(term)
      if (!normalizedTerm || normalizedTerm.length <= 1) {
        continue
      }

      if (normalizedPath === normalizedTerm) {
        addMatch(matches, {
          score: 1,
          reason: `fileName exact path matches "${term}"`,
        })
        continue
      }

      if (basename && basename === normalizedTerm) {
        addMatch(matches, {
          score: 0.95,
          reason: `fileName basename matches "${term}"`,
        })
        continue
      }

      if (stem && stem === normalizedTerm) {
        addMatch(matches, {
          score: 0.92,
          reason: `fileName stem matches "${term}"`,
        })
        continue
      }

      if (pathSegments.some((segment) => segment === normalizedTerm)) {
        addMatch(matches, {
          score: 0.88,
          reason: `fileName path segment matches "${term}"`,
        })
        continue
      }

      if (normalizedPath.includes(normalizedTerm)) {
        addMatch(matches, {
          score: 0.82,
          reason: `fileName path contains "${term}"`,
        })
        continue
      }

      if (pathSegments.some((segment) => segment.includes(normalizedTerm))) {
        addMatch(matches, {
          score: 0.78,
          reason: `fileName path segment contains "${term}"`,
        })
      }
    }

    return bestRankScore(matches)
  }
}

export class SkeletonRanker {
  score(node: Pick<GraphNode, 'name' | 'signature' | 'docComment'>, plan: GraphRAGPlan): number {
    return this.scoreWithReasons(node, plan).score
  }

  scoreWithReasons(
    node: Pick<GraphNode, 'name' | 'signature' | 'docComment'>,
    plan: GraphRAGPlan
  ): RankScore {
    const terms = uniqueStrings([...plan.extractor.entities, ...plan.extractor.keywords])
    const fields: TextMatchField[] = [
      { name: 'signature', value: node.signature, weight: 0.95 },
      { name: 'name', value: node.name, weight: 0.9 },
      { name: 'docComment', value: node.docComment, weight: 0.75 },
    ]
    const matches: TextMatch[] = []

    for (const field of fields) {
      if (!field.value) {
        continue
      }

      const normalizedValue = normalizeSearchText(field.value)
      const valueTokens = tokenize(field.value)

      for (const term of terms) {
        const normalizedTerm = normalizeSearchTerm(term)
        if (!normalizedTerm || normalizedTerm.length <= 1) {
          continue
        }

        const termTokens = tokenize(term)
        const occurrences = countOccurrences(normalizedValue, normalizedTerm)
        if (normalizedValue === normalizedTerm) {
          addMatch(matches, {
            score: field.weight,
            reason: `skeleton ${field.name} matches "${term}"`,
          })
          continue
        }

        if (occurrences > 0) {
          addMatch(matches, {
            score: field.weight,
            reason: `skeleton ${field.name} matches "${term}" ${occurrences} time${occurrences === 1 ? '' : 's'}`,
          })
          continue
        }

        if (termTokens.length > 0 && termTokens.every((token) => valueTokens.includes(token))) {
          addMatch(matches, {
            score: Math.max(0, field.weight - 0.05),
            reason: `skeleton ${field.name} contains tokens from "${term}"`,
          })
          continue
        }

        if (
          valueTokens.some(
            (token) =>
              token.includes(normalizedTerm) ||
              (normalizedTerm.length >= 3 && normalizedTerm.includes(token))
          )
        ) {
          addMatch(matches, {
            score: Math.max(0, field.weight - 0.12),
            reason: `skeleton ${field.name} partially matches "${term}"`,
          })
        }
      }
    }

    return bestRankScore(matches)
  }
}

export class DynamicBudgetReranker {
  readonly scoreThreshold: number
  readonly contextBudgetRatio: number
  readonly totalWindowTokens: number

  constructor(options: DynamicBudgetRerankerOptions = {}) {
    this.scoreThreshold = options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD
    this.contextBudgetRatio = options.contextBudgetRatio ?? DEFAULT_CONTEXT_BUDGET_RATIO
    this.totalWindowTokens = options.totalWindowTokens ?? DEFAULT_TOTAL_WINDOW_TOKENS

    validateRerankerOptions(this)
  }

  get contextBudgetTokens(): number {
    return Math.floor(this.totalWindowTokens * this.contextBudgetRatio)
  }

  rerank(subgraph: ExpandedSubgraph, plan: GraphRAGPlan): RankedFile[] {
    const fileNameRanker = new FileNameRanker()
    const skeletonRanker = new SkeletonRanker()
    const rankedFiles = groupFileNodes(subgraph.nodes)
      .map((group) => this.rankFileGroup(group, plan, fileNameRanker, skeletonRanker))
      .filter((file): file is RankedFileWithScores => file.score > this.scoreThreshold)
      .sort(sortRankedFiles)

    const budgetedFiles: RankedFile[] = []
    let usedTokens = 0

    for (const file of rankedFiles) {
      if (usedTokens + file.tokenCount <= this.contextBudgetTokens) {
        usedTokens += file.tokenCount
        budgetedFiles.push(file)
      }
    }

    return budgetedFiles
  }

  private rankFileGroup(
    group: FileGroup,
    plan: GraphRAGPlan,
    fileNameRanker: FileNameRanker,
    skeletonRanker: SkeletonRanker
  ): RankedFileWithScores {
    const representativeNode = group.nodes[0]
    const fileNameScore = fileNameRanker.scoreWithReasons(representativeNode, plan)
    const skeleton = bestSkeleton(group.nodes, plan, skeletonRanker)
    const score = Math.max(fileNameScore.score, skeleton.score)
    const tokenCount = Math.max(...group.nodes.map(estimateTokenCount))
    const skeletonText = skeleton.node?.signature

    return {
      filePath: group.filePath,
      score,
      fileNameScore: fileNameScore.score,
      skeletonScore: skeleton.score,
      tokenCount,
      reasons: uniqueStrings([...fileNameScore.reasons, ...skeleton.reasons]),
      skeleton: skeletonText,
    }
  }
}

function groupFileNodes(nodes: GraphNode[]): FileGroup[] {
  const groups = new Map<string, GraphNode[]>()

  for (const node of nodes) {
    if (!node.filePath || !isFileNode(node)) {
      continue
    }

    const existing = groups.get(node.filePath) ?? []
    existing.push(node)
    groups.set(node.filePath, existing)
  }

  return Array.from(groups.entries()).map(([filePath, groupNodes]) => ({
    filePath,
    nodes: groupNodes,
  }))
}

function isFileNode(node: GraphNode): boolean {
  return (
    node.type === 'file' || node.type === 'FILE' || node.label === 'File' || node.label === 'FILE'
  )
}

function bestSkeleton(
  nodes: GraphNode[],
  plan: GraphRAGPlan,
  skeletonRanker: SkeletonRanker
): { node?: GraphNode } & RankScore {
  let best: { node?: GraphNode } & RankScore = {
    node: undefined,
    score: 0,
    reasons: [],
  }

  for (const node of nodes) {
    const candidate = skeletonRanker.scoreWithReasons(node, plan)
    if (
      candidate.score > best.score ||
      (candidate.score === best.score && best.node === undefined)
    ) {
      best = { node, ...candidate }
    }
  }

  return best
}

function estimateTokenCount(node: GraphNode): number {
  const tokenCount = node.properties?.tokenCount
  if (typeof tokenCount === 'number' && Number.isFinite(tokenCount) && tokenCount >= 0) {
    return Math.ceil(tokenCount)
  }

  if (typeof tokenCount === 'string' && /^\d+$/.test(tokenCount)) {
    return Number.parseInt(tokenCount, 10)
  }

  const text = [node.filePath, node.name, node.signature, node.docComment]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')

  return Math.max(1, Math.ceil(tokenize(text).length * 1.25))
}

function sortRankedFiles(left: RankedFileWithScores, right: RankedFileWithScores): number {
  const scoreOrder = right.score - left.score
  if (scoreOrder !== 0) {
    return scoreOrder
  }

  return left.filePath.localeCompare(right.filePath)
}

function addMatch(matches: TextMatch[], candidate: TextMatch): void {
  if (matches.some((match) => match.reason === candidate.reason)) {
    return
  }

  matches.push(candidate)
}

function bestRankScore(matches: TextMatch[]): RankScore {
  if (matches.length === 0) {
    return { score: 0, reasons: [] }
  }

  const best = matches.reduce((current, candidate) => {
    if (candidate.score !== current.score) {
      return candidate.score > current.score ? candidate : current
    }

    if (candidate.reason.length !== current.reason.length) {
      return candidate.reason.length > current.reason.length ? candidate : current
    }

    return candidate.reason < current.reason ? candidate : current
  })

  return {
    score: best.score,
    reasons: matches
      .filter((match) => match.score === best.score)
      .map((match) => match.reason)
      .sort(),
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))
  )
}

function normalizePath(filePath: string): string {
  return filePath.replace(PATH_SEPARATOR_REGEX, '/').trim()
}

function normalizeSearchTerm(term: string): string {
  const normalizedPathTerm = normalizePath(term).toLowerCase()
  if (normalizedPathTerm.includes('/')) {
    return normalizedPathTerm
  }

  return normalizeSearchText(term)
}

function normalizeSearchText(value: string): string {
  return value
    .replace(CAMEL_CASE_BOUNDARY_REGEX, '$1 $2')
    .replace(/[^A-Za-z0-9_]+/g, ' ')
    .trim()
    .toLowerCase()
}

function tokenize(value: string): string[] {
  return uniqueStrings(
    Array.from(normalizeSearchText(value).matchAll(WORD_REGEX))
      .map((match) => match[0])
      .filter((term) => term.length > 1)
  )
}

function stripKnownExtension(basename: string): string {
  return basename.replace(/\.(ts|tsx|js|jsx|py|mjs|cjs|mts|cts)$/i, '')
}

function countOccurrences(value: string, term: string): number {
  if (term.length === 0) {
    return 0
  }

  let count = 0
  let index = value.indexOf(term)
  while (index >= 0) {
    count += 1
    index = value.indexOf(term, index + term.length)
  }

  return count
}

function validateRerankerOptions(reranker: DynamicBudgetReranker): void {
  if (!Number.isFinite(reranker.scoreThreshold)) {
    throw new Error('DynamicBudgetReranker requires a finite scoreThreshold')
  }

  if (
    !Number.isFinite(reranker.contextBudgetRatio) ||
    reranker.contextBudgetRatio <= 0 ||
    reranker.contextBudgetRatio > 1
  ) {
    throw new Error('DynamicBudgetReranker contextBudgetRatio must be in the range (0, 1]')
  }

  if (!Number.isFinite(reranker.totalWindowTokens) || reranker.totalWindowTokens < 0) {
    throw new Error('DynamicBudgetReranker totalWindowTokens must be a non-negative finite number')
  }
}
