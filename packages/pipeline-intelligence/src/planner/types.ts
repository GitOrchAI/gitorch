import { PipelineIR, RunnerRequirement } from '@gitorch/pipeline-core'
import { WorkloadProfile } from '../profiler/index.js'
import { RiskAssessment } from '../risk-engine/types.js'

export interface GenerationOptions {
  profile: WorkloadProfile
  runner?: RunnerRequirement
  defaultBranch?: string
}

export interface OptimizationOptions {
  currentIr: PipelineIR
  assessment: RiskAssessment
  runner?: RunnerRequirement
}
