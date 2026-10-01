import { z } from 'zod'

export const RiskFindingSchema = z.object({
  id: z.string(),
  category: z.enum(['security', 'testing', 'quality', 'environment', 'policy']).optional(),
  type: z
    .enum(['missing_capability', 'security_vulnerability', 'performance_issue', 'other'])
    .optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  title: z.string().optional(),
  description: z.string().optional(),
  message: z.string().optional(),
  suggestedFix: z.string().optional(),
})
export type RiskFinding = z.infer<typeof RiskFindingSchema>

export const RiskAssessmentSchema = z.object({
  score: z.number().min(0).max(100).optional(),
  findings: z.array(RiskFindingSchema),
  coveredCapabilities: z.array(z.string()).optional(),
  missingCapabilities: z.array(z.string()),
  recommendedStages: z.array(z.string()).optional(),
  scoreAntes: z.number().optional(),
  scoreDepois: z.number().optional(),
  capacidadesAdicionadas: z.array(z.string()).optional(),
})
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>
