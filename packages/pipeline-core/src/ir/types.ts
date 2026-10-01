import { z } from 'zod'

export const PipelineTriggerSchema = z.object({
  type: z.enum(['push', 'pull_request', 'schedule', 'workflow_dispatch']),
  branches: z.array(z.string()).optional(),
  paths: z.array(z.string()).optional(),
  cron: z.string().optional(),
})
export type PipelineTrigger = z.infer<typeof PipelineTriggerSchema>

export const PipelineStepSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  uses: z.string().optional(),
  run: z.string().optional(),
  with: z.record(z.unknown()).optional(),
  env: z.record(z.string()).optional(),
  continueOnError: z.boolean().optional(),
})
export type PipelineStep = z.infer<typeof PipelineStepSchema>

export const PipelineServiceSchema = z.object({
  image: z.string(),
  ports: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  options: z.string().optional(),
})
export type PipelineService = z.infer<typeof PipelineServiceSchema>

export const PipelineJobSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  runsOn: z.union([z.string(), z.array(z.string())]),
  needs: z.array(z.string()).optional(),
  environment: z.string().optional(),
  services: z.record(PipelineServiceSchema).optional(),
  steps: z.array(PipelineStepSchema),
  if: z.string().optional(),
})
export type PipelineJob = z.infer<typeof PipelineJobSchema>

export const RunnerRequirementSchema = z.object({
  type: z.enum(['hosted', 'self_hosted', 'auto']),
  os: z.union([z.enum(['ubuntu-latest', 'windows-latest', 'macos-latest']), z.string()]),
  labels: z.array(z.string()).optional(),
})
export type RunnerRequirement = z.infer<typeof RunnerRequirementSchema>

export const PipelineArtifactSchema = z.object({
  name: z.string(),
  path: z.string(),
  retentionDays: z.number().optional(),
})
export type PipelineArtifact = z.infer<typeof PipelineArtifactSchema>

export const PipelineIRSchema = z.object({
  id: z.string(),
  name: z.string(),
  triggers: z.array(PipelineTriggerSchema),
  jobs: z.record(PipelineJobSchema),
  artifacts: z.array(PipelineArtifactSchema).optional(),
  runnerRequirements: RunnerRequirementSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
})
export type PipelineIR = z.infer<typeof PipelineIRSchema>
