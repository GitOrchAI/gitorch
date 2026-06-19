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

export interface AakEncodedRecord {
  version: number
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
  private static readonly MAX_SENTENCE_LENGTH = 55

  static encode(input: AakInput): string {
    const entities = input.entities
      .map((entity) => entity.toUpperCase())
      .filter((entity) => entity.length > 0)
      .join('+')

    return [
      input.wingId,
      input.roomId,
      input.date,
      input.sourceStem,
      `0:${input.confidence}:${entities}`,
      input.topic,
      input.sentence.slice(0, this.MAX_SENTENCE_LENGTH),
      input.emotion,
      input.flag,
    ].join('|')
  }

  static decode(encoded: string): AakEncodedRecord {
    const parts = encoded.split('|')

    if (parts.length !== 9) {
      throw new Error(`Malformed AAAK record: expected 9 parts, received ${parts.length}`)
    }

    const [wingId, roomId, date, sourceStem, body, topic, sentence, emotion, flag] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ]
    const bodyParts = body.split(':')

    if (bodyParts.length !== 3) {
      throw new Error(`Malformed AAAK body: expected 3 parts, received ${bodyParts.length}`)
    }

    const version = Number(bodyParts[0])
    const confidence = Number(bodyParts[1])

    if (!Number.isFinite(version) || !Number.isFinite(confidence)) {
      throw new Error('Malformed AAAK body: version and confidence must be numeric')
    }

    return {
      version,
      wingId,
      roomId,
      date,
      sourceStem,
      confidence,
      entities: bodyParts[2]?.split('+').filter((entity) => entity.length > 0) ?? [],
      topic,
      sentence,
      emotion,
      flag,
    }
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

  static toDrawer(encoded: string): CortexDrawer {
    const record = this.decode(encoded)

    return {
      id: encoded,
      wingId: record.wingId,
      roomId: record.roomId,
      hallId: record.sourceStem,
      content: record.sentence,
      importance: record.flag === 'CORE' ? 1 : 0.5,
      emotionalWeight: record.emotion === 'high' ? 0.8 : 0.2,
      createdAt: record.date,
      validFrom: record.date,
      confidence: record.confidence,
      tags: record.entities,
    }
  }
}
