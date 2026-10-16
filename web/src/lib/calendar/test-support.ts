/**
 * Test-only stand-in for the service-role Supabase client used by the calendar
 * routes. It is not imported by any app code. Each `from(table)` call records
 * the chain it was given (filters, select columns, insert/update payload), and
 * resolves to the next queued result for that table when the chain is awaited
 * or ends in maybeSingle()/single(). Unqueued calls resolve to empty data, so a
 * test only has to queue the reads it cares about.
 */

export type RecordedStep = { method: string; args: unknown[] };
export type RecordedQuery = { table: string; steps: RecordedStep[] };
export type FakeResult = {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
};
export type FakeAdmin = ReturnType<typeof createFakeAdmin>;

export function createFakeAdmin(queued: Record<string, FakeResult[]> = {}) {
  const queries: RecordedQuery[] = [];

  const settle = (table: string) => {
    const result = queued[table]?.shift() ?? {};
    return {
      data: result.data ?? null,
      error: result.error ?? null,
      count: result.count ?? null,
    };
  };

  const from = (table: string) => {
    const query: RecordedQuery = { table, steps: [] };
    queries.push(query);

    const terminals: Record<string, unknown> = {
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(settle(table)).then(resolve, reject),
      maybeSingle: async () => settle(table),
      single: async () => settle(table),
    };

    const builder: Record<string, unknown> = new Proxy(terminals, {
      get(target, prop) {
        if (typeof prop !== "string") return undefined;
        if (prop in target) return target[prop];
        return (...args: unknown[]) => {
          query.steps.push({ method: prop, args });
          return builder;
        };
      },
    });
    return builder;
  };

  const client = {
    from,
    rpc: async () => ({
      data: { allowed: true, remaining: 999, retry_after_seconds: 0 },
      error: null,
    }),
  };

  return { client, queries };
}

/** Every query recorded against one table, in call order. */
export function queriesOn(admin: FakeAdmin, table: string): RecordedQuery[] {
  return admin.queries.filter((q) => q.table === table);
}

/** Column → value for every `.eq()` on a query. */
export function eqFilters(query: RecordedQuery): Record<string, unknown> {
  return Object.fromEntries(
    query.steps.filter((s) => s.method === "eq").map((s) => [s.args[0] as string, s.args[1]]),
  );
}

/** The insert or update payload of a query, if it has one. */
export function writePayload(query: RecordedQuery): Record<string, unknown> | undefined {
  const step = query.steps.find((s) => s.method === "insert" || s.method === "update");
  return step?.args[0] as Record<string, unknown> | undefined;
}

/** The column list passed to `.select()`, if any. */
export function selectedColumns(query: RecordedQuery): string | undefined {
  const step = query.steps.find((s) => s.method === "select");
  return step?.args[0] as string | undefined;
}
