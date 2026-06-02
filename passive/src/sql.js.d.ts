declare module "sql.js" {
  export interface Database {
    exec(sql: string): QueryExecResult[]
    prepare(sql: string): Statement
    close(): void
  }
  export interface Statement {
    bind(params?: unknown[]): void
    step(): boolean
    get(): unknown[]
    getColumnNames(): string[]
    free(): void
  }
  export interface QueryExecResult {
    columns: string[]
    values: unknown[][]
  }
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number>) => Database
  }
  export default function initSqlJs(): Promise<SqlJsStatic>
}