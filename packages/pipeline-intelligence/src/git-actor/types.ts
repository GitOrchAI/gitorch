import { RiskAssessment } from '../risk-engine/types.js'

export type AutonomiaModo = 'so_olhar' | 'sugerir' | 'cuidar'

export interface GitActorParams {
  octokit: unknown
  owner: string
  repo: string
  autonomy: AutonomiaModo
  optimizedYaml: string
  workflowPath?: string // default: '.github/workflows/ci.yml'
  assessment: RiskAssessment
  baseBranch?: string // default: 'main'
  branchName?: string
}

export interface GitActionResult {
  action: 'observed' | 'pr_created' | 'pr_created_with_automerge'
  branch?: string
  prNumber?: number
  prUrl?: string
  issueNumber?: number
  message: string
}
