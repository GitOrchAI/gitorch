import type { ExpandedSubgraph, RankedFile, ReaderPayload } from '../types'

export interface NodeTokenAdapter {
  compressChunkToNodeToken(chunk: string): string
}

const NODE_TOKEN_PREFIX = 'node-token'
const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193
const PATCH_FORMAT_INSTRUCTIONS = [
  'Generate a Git-compatible diff/patch.',
  'Keep changes scoped to ranked files.',
  'Add or update regression tests when the issue implies behavior.',
  'Do not include explanatory prose outside the patch unless requested.',
] as const

export class DeterministicNodeTokenAdapter implements NodeTokenAdapter {
  compressChunkToNodeToken(chunk: string): string {
    const hash = hashString(chunk)

    return `${NODE_TOKEN_PREFIX}-${hash}-${chunk.length}`
  }
}

export class PatchPromptBuilder {
  buildGraphSummary(subgraph: Pick<ExpandedSubgraph, 'anchors' | 'edges' | 'nodes'>): string {
    return [
      'Graph summary:',
      `- nodes: ${subgraph.nodes.length}`,
      `- edges: ${subgraph.edges.length}`,
      `- anchors: ${subgraph.anchors.length}`,
    ].join('\n')
  }

  buildRankedFileSection(rankedFiles: RankedFile[]): string {
    const rankedFileLines = rankedFiles.map((file) => `- ${file.filePath} (score: ${file.score})`)

    return ['Ranked files:', ...rankedFileLines].join('\n')
  }

  buildInstructions(graphSummary: string, rankedFiles: RankedFile[]): string {
    return [
      'System grounding: Use the graph context and ranked files to produce a patch.',
      graphSummary,
      this.buildRankedFileSection(rankedFiles),
      'Constraints:',
      ...PATCH_FORMAT_INSTRUCTIONS,
      'Expected diff/patch format: Return a Git-compatible unified diff containing only files listed in Ranked files.',
    ].join('\n')
  }

  build(
    subgraph: Pick<ExpandedSubgraph, 'anchors' | 'edges' | 'nodes'>,
    rankedFiles: RankedFile[]
  ): string {
    return this.buildInstructions(this.buildGraphSummary(subgraph), rankedFiles)
  }
}

export class GraphReader {
  constructor(
    private readonly nodeTokenAdapter: NodeTokenAdapter = new DeterministicNodeTokenAdapter(),
    private readonly patchPromptBuilder: PatchPromptBuilder = new PatchPromptBuilder()
  ) {}

  read(subgraph: ExpandedSubgraph, rankedFiles: RankedFile[]): ReaderPayload {
    if (subgraph.isolatedNodes.length > 0 && subgraph.nodes.length === 0) {
      throw new Error('Cannot read isolated subgraph with no connected nodes.')
    }

    const nodeTokens = rankedFiles.map((file) =>
      this.nodeTokenAdapter.compressChunkToNodeToken(file.skeleton ?? file.filePath)
    )
    const graphSummary = this.patchPromptBuilder.buildGraphSummary(subgraph)
    const patchFormatInstructions = this.patchPromptBuilder.buildInstructions(
      graphSummary,
      rankedFiles
    )

    return {
      graphSummary,
      rankedFiles,
      nodeTokens,
      patchFormatInstructions,
    }
  }
}

function hashString(value: string): string {
  let hash = FNV_OFFSET_BASIS

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}
