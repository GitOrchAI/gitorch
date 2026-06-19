import Database, { type Database as DatabaseType } from 'better-sqlite3'
import type { CortexDrawer, CortexIdentity, CortexTriple } from '../types'

export interface TripleQuery {
  wingId: string
  at: string
  subject?: string
  predicate?: string
  object?: string
}

type StoredTriple = CortexTriple & { wingId: string }
type SqliteRow = {
  id: unknown
  wing_id: unknown
  room_id: unknown
  hall_id: unknown
  content: unknown
  importance: unknown
  emotional_weight: unknown
  created_at: unknown
  valid_from: unknown
  valid_to: unknown
  confidence: unknown
  tags: unknown
}

export class SqliteStore {
  private readonly db: DatabaseType

  constructor(path: string) {
    this.db = new Database(path)
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cortex_identities (
        wing_id TEXT PRIMARY KEY,
        persona TEXT NOT NULL,
        orchestration_guidelines TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cortex_drawers (
        id TEXT PRIMARY KEY,
        wing_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        hall_id TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL NOT NULL,
        emotional_weight REAL NOT NULL,
        created_at TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        confidence REAL NOT NULL,
        tags TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cortex_drawers_scope
        ON cortex_drawers (wing_id, room_id, hall_id);

      CREATE INDEX IF NOT EXISTS idx_cortex_drawers_priority
        ON cortex_drawers (wing_id, importance DESC, emotional_weight DESC);

      CREATE TABLE IF NOT EXISTS cortex_triples (
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        wing_id TEXT NOT NULL,
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        confidence REAL NOT NULL,
        PRIMARY KEY (subject, predicate, object, wing_id, valid_from)
      );

      CREATE INDEX IF NOT EXISTS idx_cortex_triples_time
        ON cortex_triples (wing_id, valid_from, valid_to);
    `)
  }

  upsertIdentity(identity: CortexIdentity): void {
    this.db
      .prepare(
        `
      INSERT INTO cortex_identities (wing_id, persona, orchestration_guidelines)
      VALUES (@wingId, @persona, @orchestrationGuidelines)
      ON CONFLICT(wing_id) DO UPDATE SET
        persona = excluded.persona,
        orchestration_guidelines = excluded.orchestration_guidelines
    `
      )
      .run(identity)
  }

  getIdentity(wingId: string): CortexIdentity | null {
    const row = this.db
      .prepare(
        `
      SELECT
        wing_id AS wingId,
        persona,
        orchestration_guidelines AS orchestrationGuidelines
      FROM cortex_identities
      WHERE wing_id = ?
    `
      )
      .get(wingId) as CortexIdentity | undefined

    return row ?? null
  }

  upsertDrawer(drawer: CortexDrawer): void {
    this.db
      .prepare(
        `
      INSERT INTO cortex_drawers (
        id,
        wing_id,
        room_id,
        hall_id,
        content,
        importance,
        emotional_weight,
        created_at,
        valid_from,
        valid_to,
        confidence,
        tags
      ) VALUES (
        @id,
        @wingId,
        @roomId,
        @hallId,
        @content,
        @importance,
        @emotionalWeight,
        @createdAt,
        @validFrom,
        @validTo,
        @confidence,
        @tags
      )
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        importance = excluded.importance,
        emotional_weight = excluded.emotional_weight,
        valid_from = excluded.valid_from,
        valid_to = excluded.valid_to,
        confidence = excluded.confidence,
        tags = excluded.tags
    `
      )
      .run({
        ...drawer,
        validTo: drawer.validTo ?? null,
        tags: JSON.stringify(drawer.tags),
      })
  }

  getTopDrawers(wingId: string, limit: number): CortexDrawer[] {
    return (
      this.db
        .prepare(
          `
      SELECT *
      FROM cortex_drawers
      WHERE wing_id = ?
      ORDER BY importance DESC, emotional_weight DESC
      LIMIT ?
    `
        )
        .all(wingId, limit) as SqliteRow[]
    ).map((row) => this.mapDrawer(row))
  }

  getDrawersByScope(wingId: string, roomId?: string, hallId?: string, limit = 20): CortexDrawer[] {
    const clauses = ['wing_id = ?']
    const params: unknown[] = [wingId]

    if (roomId) {
      clauses.push('room_id = ?')
      params.push(roomId)
    }

    if (hallId) {
      clauses.push('hall_id = ?')
      params.push(hallId)
    }

    params.push(limit)

    return (
      this.db
        .prepare(
          `
      SELECT *
      FROM cortex_drawers
      WHERE ${clauses.join(' AND ')}
      ORDER BY importance DESC, emotional_weight DESC
      LIMIT ?
    `
        )
        .all(...params) as SqliteRow[]
    ).map((row) => this.mapDrawer(row))
  }

  insertTriple(triple: StoredTriple): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO cortex_triples (
        subject,
        predicate,
        object,
        wing_id,
        valid_from,
        valid_to,
        confidence
      ) VALUES (
        @subject,
        @predicate,
        @object,
        @wingId,
        @validFrom,
        @validTo,
        @confidence
      )
    `
      )
      .run(triple)
  }

  queryTriples(query: TripleQuery): StoredTriple[] {
    const clauses = ['wing_id = ?', 'valid_from <= ?', '(valid_to IS NULL OR valid_to >= ?)']
    const params: unknown[] = [query.wingId, query.at, query.at]

    if (query.subject) {
      clauses.push('subject = ?')
      params.push(query.subject)
    }

    if (query.predicate) {
      clauses.push('predicate = ?')
      params.push(query.predicate)
    }

    if (query.object) {
      clauses.push('object = ?')
      params.push(query.object)
    }

    return this.db
      .prepare(
        `
      SELECT
        subject,
        predicate,
        object,
        wing_id AS wingId,
        valid_from AS validFrom,
        valid_to AS validTo,
        confidence
      FROM cortex_triples
      WHERE ${clauses.join(' AND ')}
      ORDER BY confidence DESC
    `
      )
      .all(...params) as StoredTriple[]
  }

  close(): void {
    this.db.close()
  }

  private mapDrawer(row: SqliteRow): CortexDrawer {
    return {
      id: String(row['id']),
      wingId: String(row['wing_id']),
      roomId: String(row['room_id']),
      hallId: String(row['hall_id']),
      content: String(row['content']),
      importance: Number(row['importance']),
      emotionalWeight: Number(row['emotional_weight']),
      createdAt: String(row['created_at']),
      validFrom: String(row['valid_from']),
      validTo: row['valid_to'] ? String(row['valid_to']) : undefined,
      confidence: Number(row['confidence']),
      tags: JSON.parse(String(row['tags'])) as string[],
    }
  }
}
