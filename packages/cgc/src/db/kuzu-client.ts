import { Database, Connection, QueryResult } from 'kuzu'

export interface QueryResultRow {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

export interface QueryOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parameters?: Record<string, any>
}

export class KuzuClient {
  private db: Database
  private conn: Connection
  private closed = false

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath)
    this.conn = new Connection(this.db)
  }

  async init(): Promise<void> {
    await this.db.init()
    await this.conn.init()
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async execute(query: string, parameters?: Record<string, any>): Promise<void> {
    if (this.closed) throw new Error('Client is closed')

    // Auto-add primary key to CREATE NODE TABLE if missing
    let finalQuery = query
    if (/^CREATE\s+NODE\s+TABLE\s+/i.test(query) && !/PRIMARY\s+KEY/i.test(query)) {
      // Add id column as primary key
      finalQuery = query.replace(/\)\s*$/, ', id UUID, PRIMARY KEY(id))')
    }

    if (parameters && Object.keys(parameters).length > 0) {
      const stmt = await this.conn.prepare(finalQuery)
      if (!stmt.isSuccess()) {
        throw new Error(`Prepare failed: ${stmt.getErrorMessage()}`)
      }
      await this.conn.execute(stmt, parameters)
    } else {
      await this.conn.query(finalQuery)
    }
  }

  async query(query: string, options: QueryOptions = {}): Promise<QueryResultRow[]> {
    if (this.closed) throw new Error('Client is closed')

    let result: QueryResult
    if (options.parameters && Object.keys(options.parameters).length > 0) {
      const stmt = await this.conn.prepare(query)
      if (!stmt.isSuccess()) {
        throw new Error(`Prepare failed: ${stmt.getErrorMessage()}`)
      }
      result = await this.conn.execute(stmt, options.parameters)
    } else {
      result = await this.conn.query(query)
    }

    return this.resultToArray(result)
  }

  private async resultToArray(result: QueryResult): Promise<QueryResultRow[]> {
    return await result.getAll()
  }

  async createNodeTable(
    label: string,
    properties: Record<string, string>,
    primaryKey: string = 'id'
  ): Promise<void> {
    const props = Object.entries(properties)
      .map(([name, type]) => `${name} ${type}`)
      .join(', ')
    await this.execute(`CREATE NODE TABLE ${label}(${props}, PRIMARY KEY(${primaryKey}))`)
  }

  async createRelTable(
    label: string,
    from: string,
    to: string,
    properties: Record<string, string> = {}
  ): Promise<void> {
    const props = Object.entries(properties)
      .map(([name, type]) => `${name} ${type}`)
      .join(', ')
    const propClause = props ? `, ${props}` : ''
    await this.execute(`CREATE REL TABLE ${label}(FROM ${from} TO ${to}${propClause})`)
  }

  async close(): Promise<void> {
    if (!this.closed) {
      await this.conn.close()
      await this.db.close()
      this.closed = true
    }
  }

  isClosed(): boolean {
    return this.closed
  }
}
