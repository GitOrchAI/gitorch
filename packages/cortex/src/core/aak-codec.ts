import type { CortexDrawer } from '../types'

export interface AakInput {
  wingId: string
  roomId: string
  date: string
  sourceStem: string
  confidence: number
  entities: string[]
  topic: string
  sentence: string
  emotion: string
  flag: string
}

export class AakCodec {
  static encode(input: AakInput): string {
    return [
      input.wingId,
      input.roomId,
      input.date,
      input.sourceStem,
      `0:${input.confidence}:${input.entities.join('+')}`,
      input.topic,
      input.sentence.slice(0, 55),
      input.emotion,
      input.flag,
    ].join('|')
  }

  static fromDrawer(drawer: CortexDrawer): string {
    return this.encode({
      wingId: drawer.wingId,
      roomId: drawer.roomId,
      date: drawer.validFrom.slice(0, 10),
      sourceStem: drawer.hallId,
      confidence: drawer.confidence,
      entities: drawer.tags,
      topic: drawer.hallId,
      sentence: drawer.content,
      emotion: drawer.emotionalWeight >= 0.7 ? 'high' : 'neutral',
      flag: drawer.importance >= 0.8 ? 'CORE' : 'STD',
    })
  }
}
