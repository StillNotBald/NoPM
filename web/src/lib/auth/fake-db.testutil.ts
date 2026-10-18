/**
 * Tiny recording fake of the supabase-js admin client for route tests: every
 * query-builder method returns the same chainable builder, and the terminal
 * (`await` / maybeSingle / single) asks `handler` what the table "returned".
 * Not a test file (no `.test.`), so vitest does not collect it.
 */
export type Call = {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  payload?: unknown;
  filters: Array<[string, ...unknown[]]>;
};
export type Result = { data?: unknown; error?: { message: string; code?: string } | null; count?: number };

/**
 * Default RPC answers: the rate limiter always allows, and nopm_mutate_audited (migration 0103, the atomic
 * write + audit function) echoes the patch back as the written row so a route under test can build its response.
 */
function defaultRpc(fn: string, args: Record<string, unknown>): Result {
  if (fn === "nopm_mutate_audited") {
    const patch = (args.p_patch as Record<string, unknown> | null) ?? {};
    const id = (args.p_id as string | null) ?? "00000000-0000-4000-8000-0000000000aa";
    const row = { id, workspace_id: args.p_workspace_id, ...patch };
    return { data: { before: args.p_op === "insert" ? null : { id, workspace_id: args.p_workspace_id }, after: args.p_op === "delete" ? null : row }, error: null };
  }
  return { data: { allowed: true, remaining: 99, retry_after_seconds: 0 }, error: null };
}

export function fakeDb(
  handler: (call: Call) => Result | undefined,
  rpcHandler: (fn: string, args: Record<string, unknown>) => Result = defaultRpc,
) {
  const calls: Call[] = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  function from(table: string) {
    const call: Call = { table, op: "select", filters: [] };
    let recorded = false;
    const finish = () => {
      if (!recorded) {
        recorded = true;
        calls.push(call);
      }
      const r = handler(call) ?? {};
      return { data: r.data ?? null, error: r.error ?? null, count: r.count };
    };
    const builder: Record<string, unknown> = {};
    const chain = (name: string) => (...args: unknown[]) => {
      call.filters.push([name, ...args]);
      return builder;
    };
    for (const m of ["eq", "neq", "is", "in", "lt", "lte", "gt", "gte", "or", "not", "ilike", "contains", "order", "range", "limit"]) {
      builder[m] = chain(m);
    }
    builder.select = (...args: unknown[]) => {
      call.filters.push(["select", ...args]);
      return builder;
    };
    for (const op of ["insert", "update", "upsert", "delete"] as const) {
      builder[op] = (payload?: unknown) => {
        call.op = op;
        call.payload = payload;
        return builder;
      };
    }
    builder.maybeSingle = async () => finish();
    builder.single = async () => finish();
    builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(finish()).then(resolve, reject);
    return builder;
  }

  return {
    client: {
      from,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        const r = rpcHandler(fn, args);
        return { data: r.data ?? null, error: r.error ?? null };
      },
    },
    calls,
    rpcCalls,
    /** Audit rows written: direct audit_log inserts plus the audit half of every nopm_mutate_audited call. */
    auditRows: (): Record<string, unknown>[] => [
      ...calls.filter((c) => c.table === "audit_log" && c.op === "insert").map((c) => c.payload as Record<string, unknown>),
      ...rpcCalls
        .filter((c) => c.fn === "nopm_mutate_audited")
        .map((c) => ({ workspace_id: c.args.p_workspace_id, ...(c.args.p_audit as Record<string, unknown>) })),
    ],
  };
}
