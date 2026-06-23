import type { ExecutionRecord, PheromoneMark, SynapseEvent, SynapseScope } from '../types'

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

export interface CortexWriter {
  writeTriple(triple: CortexTriple & { wingId: string }): void
  writeDrawer(drawer: CortexDrawer): Promise<void>
}

export class SynapseCortexAdapter {
  constructor(private readonly cortex: CortexWriter) {}

  async persistEvent(event: SynapseEvent): Promise<void> {
    this.cortex.writeTriple({
      wingId: event.scope.wingId,
      subject: scopeSubject(event.scope),
      predicate: 'EMITTED_EVENT',
      object: event.type,
      validFrom: event.createdAt,
      confidence: 1,
    })

    await this.cortex.writeDrawer({
      id: `synapse-event-${event.id}`,
      wingId: event.scope.wingId,
      roomId: 'synapse',
      hallId: 'events',
      content: JSON.stringify(event),
      importance: 0.6,
      emotionalWeight: 0.2,
      createdAt: event.createdAt,
      validFrom: event.createdAt,
      confidence: 1,
      tags: ['synapse', 'event', event.type],
    })
  }

  async persistExecution(record: ExecutionRecord): Promise<void> {
    this.cortex.writeTriple({
      wingId: record.scope.wingId,
      subject: scopeSubject(record.scope),
      predicate: 'RECORDED_EXECUTION',
      object: record.actionKey,
      validFrom: record.startedAt,
      validTo: record.completedAt,
      confidence: executionConfidence(record),
    })

    await this.cortex.writeDrawer({
      id: `synapse-execution-${record.id}`,
      wingId: record.scope.wingId,
      roomId: 'synapse',
      hallId: 'executions',
      content: JSON.stringify(record),
      importance: executionImportance(record),
      emotionalWeight: executionEmotionalWeight(record),
      createdAt: record.startedAt,
      validFrom: record.startedAt,
      validTo: record.completedAt,
      confidence: executionConfidence(record),
      tags: ['synapse', 'execution', record.status, record.agent.role],
    })
  }

  async persistPheromone(mark: PheromoneMark): Promise<void> {
    this.cortex.writeTriple({
      wingId: mark.scope.wingId,
      subject: scopeSubject(mark.scope),
      predicate: 'HAS_PHEROMONE',
      object: mark.type,
      validFrom: mark.createdAt,
      validTo: mark.expiresAt,
      confidence: mark.strength,
    })

    await this.cortex.writeDrawer({
      id: `synapse-pheromone-${mark.id}`,
      wingId: mark.scope.wingId,
      roomId: 'synapse',
      hallId: 'pheromones',
      content: JSON.stringify(mark),
      importance: pheromoneImportance(mark),
      emotionalWeight: pheromoneEmotionalWeight(mark),
      createdAt: mark.createdAt,
      validFrom: mark.createdAt,
      validTo: mark.expiresAt,
      confidence: mark.strength,
      tags: ['synapse', 'pheromone', mark.type],
    })
  }
}

function scopeSubject(scope: SynapseScope): string {
  return `synapse:${scope.type}:${scope.targetId}`
}

function executionConfidence(record: ExecutionRecord): number {
  return record.status === 'completed' ? 1 : 0.8
}

function executionImportance(record: ExecutionRecord): number {
  return record.status === 'blocked' ? 0.9 : 0.7
}

function executionEmotionalWeight(record: ExecutionRecord): number {
  if (record.status === 'blocked') {
    return 0.9
  }

  return record.status === 'skipped' ? 0.4 : 0.3
}

function pheromoneImportance(mark: PheromoneMark): number {
  return mark.type === 'warning' ? 1 : 0.7
}

function pheromoneEmotionalWeight(mark: PheromoneMark): number {
  return mark.type === 'blocked' || mark.type === 'warning' ? 0.9 : 0.3
}
