// Wave-5 Pre-3: minimal ambient types for the already-approved `pg` package (8.x), used only by
// the audit-chain anchor sink (R-168..R-170). `@types/pg` is deliberately NOT added (no new
// dependency); this shim covers exactly the surface the anchor code uses. Extend here, never
// loosen to `any` elsewhere.
declare module "pg" {
  export interface ClientConfig {
    connectionString?: string;
    ssl?: boolean | { rejectUnauthorized?: boolean };
    connectionTimeoutMillis?: number;
    statement_timeout?: number;
    query_timeout?: number;
    application_name?: string;
  }
  export interface QueryResultRow {
    [column: string]: unknown;
  }
  export interface QueryResult<R extends QueryResultRow = QueryResultRow> {
    rows: R[];
    rowCount: number | null;
    command: string;
  }
  export class Client {
    constructor(config?: ClientConfig | string);
    connect(): Promise<void>;
    end(): Promise<void>;
    query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>;
  }
  export class Pool {
    constructor(config?: ClientConfig & { max?: number; idleTimeoutMillis?: number });
    connect(): Promise<Client & { release(err?: Error | boolean): void }>;
    query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }
  const pg: { Client: typeof Client; Pool: typeof Pool };
  export default pg;
}
