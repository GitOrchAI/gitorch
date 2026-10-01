import { z } from 'zod'

export const RiskFindingSchema = z.object({
  id: z.string(),
  category: z.enum(['security', 'testing', 'quality', 'environment', 'policy']),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  title: z.string(),
  description: z.string(),
  suggestedFix: z.string(),
})
export type RiskFinding = z.infer<typeof RiskFindingSchema>

export const RiskAssessmentSchema = z.object({
  score: z.number().min(0).max(100),
  findings: z.array(RiskFindingSchema),
  coveredCapabilities: z.array(z.string()),
  missingCapabilities: z.array(z.string()),
  recommendedStages: z.array(z.string()),
})
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>
