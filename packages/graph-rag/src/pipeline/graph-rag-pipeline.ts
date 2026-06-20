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
    const plan = this.rewrite(rawIssue, options)
    const context = await this.buildCortexContextIfRequested(plan, rawIssue, options)
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
    plan: GraphRAGPlan,
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
}
