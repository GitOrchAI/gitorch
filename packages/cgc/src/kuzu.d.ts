declare module 'kuzu' {
  export class Database {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(path: string, options?: any)
    init(): Promise<void>
    close(): Promise<void>
  }
  export class Connection {
    constructor(db: Database)
    init(): Promise<void>
    query(query: string): Promise<QueryResult>
    prepare(query: string): Promise<PreparedStatement>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute(stmt: PreparedStatement, parameters?: Record<string, any>): Promise<QueryResult>
    close(): Promise<void>
  }
  export class PreparedStatement {
    isSuccess(): boolean
    getErrorMessage(): string
  }
  export class QueryResult {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getAll(): Promise<any[]>
  }
}
