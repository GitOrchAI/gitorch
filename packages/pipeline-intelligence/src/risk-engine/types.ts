export interface RiskAssessment {
  findings: Array<{
    id: string
    type: 'missing_capability' | 'security_vulnerability' | 'performance_issue' | 'other'
    severity: 'high' | 'medium' | 'low'
    message: string
  }>
  missingCapabilities: string[]
}
