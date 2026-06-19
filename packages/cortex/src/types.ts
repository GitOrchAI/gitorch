export type CortexLayer = 'L0' | 'L1' | 'L2' | 'L3'

export interface CortexIdentity {
  wingId: string
  persona: string
  orchestrationGuidelines: string
}

export interface CortexDrawer {
  id: string
  wingId: string
  roomId: string
  hallId: string
  content: string
  importance: number
  emotionalWeight: number
  createdAt: string
  validFrom: string
  validTo?: string
  confidence: number
  tags: string[]
}

export interface CortexTriple {
  subject: string
  predicate: string
  object: string
  validFrom: string
  validTo?: string
  confidence: number
}

export interface CortexSearchResult {
  drawerId: string
  layer: CortexLayer
  score: number
  content: string
  metadata: CortexDrawer
}

export interface CortexWakeUpResult {
  identity: CortexIdentity
  drawers: CortexDrawer[]
  tokenBudget: number
}
