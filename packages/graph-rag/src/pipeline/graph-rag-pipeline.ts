import { CortexGraphRAGAdapter, type CortexPlanContext } from '../cortex/cortex-integration'
import { GraphReader } from '../reader/reader'
import { DynamicBudgetReranker } from '../reranker/reranker'
import { GraphRetriever } from '../retriever/retriever'
import type { GraphRepository } from '../retriever/kuzu-graph-repository'
import type { GraphRAGPipelineResult, GraphRAGPlan } from '../types'
import { QueryRewriter } from '../rewriter/rewriter'

export interface GraphRAGPipelineOptions {
  repository: GraphRepository
  reranker?: DynamicBudgetReranker
  reader?: GraphReader
  cortex?: CortexGraphRAGAdapter
}

export interface GraphRAGPipelineRunOptions {
  wingId?: string
  roomId?: string
  hallId?: string
}

type PipelineResultWithContext = GraphRAGPipelineResult & {
  context?: CortexPlanContext
}

export class GraphRAGPipeline {
  private readonly rewriter: QueryRewriter
  private readonly retriever: GraphRetriever
  private readonly reranker: DynamicBudgetReranker
  private readonly reader: GraphReader

  constructor(private readonly options: GraphRAGPipelineOptions) {
    this.rewriter = new QueryRewriter()
    this.retriever = new GraphRetriever(options.repository)
    this.reranker = options.reranker ?? new DynamicBudgetReranker()
    this.reader = options.reader ?? new GraphReader()
  }

  async run(
    rawIssue: string,
    options: GraphRAGPipelineRunOptions = {}
  ): Promise<PipelineResultWithContext> {
    const basePlan = this.rewrite(rawIssue, options)
    const context = await this.buildCortexContextIfRequested(basePlan, rawIssue, options)
    const plan = context ? this.enrichPlanWithContext(basePlan, context) : basePlan
    const subgraph = await this.retriever.retrieve(plan)
    const rankedFiles = this.reranker.rerank(subgraph, plan)
    const payload = this.reader.read(subgraph, rankedFiles)

    return {
      plan,
      payload,
      ...(context ? { context } : {}),
    } satisfies PipelineResultWithContext
  }

  private rewrite(rawIssue: string, options: GraphRAGPipelineRunOptions): GraphRAGPlan {
    return {
      ...this.rewriter.rewrite(rawIssue),
      ...options,
    }
  }

  private async buildCortexContextIfRequested(
    _plan: GraphRAGPlan,
    rawIssue: string,
    options: GraphRAGPipelineRunOptions
  ): Promise<CortexPlanContext | undefined> {
    if (!options.wingId || !this.options.cortex) {
      return undefined
    }

    return this.options.cortex.buildPlanContext(
      options.wingId,
      rawIssue,
      options.roomId,
      options.hallId
    )
  }

  private enrichPlanWithContext(plan: GraphRAGPlan, context: CortexPlanContext): GraphRAGPlan {
    const semanticTermGroups = context.semanticAnchors.map((anchor) =>
      collectContextTerms(anchor.content, anchor.metadata)
    )
    const semanticTerms = mergeContextTerms(semanticTermGroups)
    const localScopeTerms = collectContextTerms(undefined, context.localScope)
    const identityTerms = collectContextTerms(undefined, context.identity)

    return {
      ...plan,
      extractor: {
        entities: dedupeTerms([
          ...plan.extractor.entities,
          ...identityTerms.entities,
          ...localScopeTerms.entities,
          ...semanticTerms.entities,
        ]),
        keywords: dedupeTerms([
          ...plan.extractor.keywords,
          ...identityTerms.keywords,
          ...localScopeTerms.keywords,
          ...semanticTerms.keywords,
        ]),
      },
    }
  }
}

type ContextTerms = {
  entities: string[]
  keywords: string[]
}

function collectContextTerms(content?: string, metadata?: unknown): ContextTerms {
  const entities = new Set<string>()
  const keywords = new Set<string>()
  const values = collectStrings([content, metadata])

  for (const value of values) {
    for (const token of tokenizeContextValue(value)) {
      if (looksLikeEntity(token)) {
        entities.add(token)
      }
      keywords.add(token)
    }
  }

  return {
    entities: [...entities],
    keywords: [...keywords],
  }
}

function collectStrings(values: unknown[]): string[] {
  const collected: string[] = []

  for (const value of values) {
    if (!value) {
      continue
    }

    if (typeof value === 'string') {
      collected.push(value)
      continue
    }

    if (Array.isArray(value)) {
      collected.push(...collectStrings(value))
      continue
    }

    if (typeof value === 'object') {
      collected.push(...collectStrings(Object.values(value as Record<string, unknown>)))
    }
  }

  return collected
}

function tokenizeContextValue(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9_./-]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2)
}

function looksLikeEntity(token: string): boolean {
  return /[A-Z]/.test(token) || /[./]/.test(token)
}

function dedupeTerms(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))]
}

function mergeContextTerms(values: ContextTerms[]): ContextTerms {
  return {
    entities: dedupeTerms(values.flatMap((value) => value.entities)),
    keywords: dedupeTerms(values.flatMap((value) => value.keywords)),
  }
}
