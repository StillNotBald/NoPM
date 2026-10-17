/**
 * In-memory stand-in for the service-role Supabase client, for unit tests of
 * the governed decision paths (decide.ts and the thin REST routes over it).
 * Test support only — nothing in the app imports this.
 *
 * It implements just the query-builder surface those paths use: select / eq /
 * in / insert / update / upsert / maybeSingle / single / thenable-await, plus
 * `rpc`. The two deletion-commit RPCs are simulated by `commitDeletionRpc`,
 * which mirrors the guard ORDER and error codes of migration 0045 (so a test
 * of the TypeScript error mapping exercises the same contract the database
 * enforces; the SQL itself is covered by the migration-text test and the
 * local-DB probes).
 */

export type Row = Record<string, unknown>;
export type RpcError = { message: string; code?: string };
export type RpcResult = { data: unknown; error: RpcError | null };
export type RpcHandler = (args: Record<string, unknown>, db: FakeDb) => RpcResult | Promise<RpcResult>;

type Filter = (row: Row) => boolean;

type Hook = { table: string; fn: (db: FakeDb) => void };

export class FakeDb {
  tables: Record<string, Row[]> = {};
  rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  rpcHandlers: Record<string, RpcHandler> = {
    nopm_rate_check: () => ({
      data: { allowed: true, remaining: 999, retry_after_seconds: 0 },
      error: null,
    }),
    nopm_commit_task_deletion: commitDeletionRpc,
    nopm_commit_project_deletion: commitDeletionRpc,
    nopm_project_child_counts: (args, db) => ({
      data: projectChildCounts(db, args.p_project_id as string),
      error: null,
    }),
  };
  private seq = 0;
  private hooks: Hook[] = [];

  constructor(seed: Record<string, Row[]> = {}) {
    for (const [table, rows] of Object.entries(seed)) {
      this.tables[table] = rows.map((r) => ({ ...r }));
    }
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  /** Run `fn` once, right after the next SELECT on `table` returns (to simulate a concurrent writer). */
  afterNextSelect(table: string, fn: (db: FakeDb) => void): void {
    this.hooks.push({ table, fn });
  }

  rpcCallsTo(name: string) {
    return this.rpcCalls.filter((c) => c.name === name);
  }

  nextId(table: string): string {
    this.seq += 1;
    return `${table}-${this.seq}`;
  }

  fireHooks(table: string): void {
    const idx = this.hooks.findIndex((h) => h.table === table);
    if (idx < 0) return;
    const [hook] = this.hooks.splice(idx, 1);
    hook.fn(this);
  }

  readonly client = {
    from: (table: string) => new Builder(this, table),
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      this.rpcCalls.push({ name, args });
      const handler = this.rpcHandlers[name];
      if (!handler) return { data: null, error: { message: `function ${name} does not exist`, code: "42883" } };
      return handler(args, this);
    },
  };
}

class Builder implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private filters: Filter[] = [];
  private patch: Row | null = null;
  private payload: Row[] = [];
  private onConflict: string[] = [];
  private returning = false;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}

  select(_columns?: string, _opts?: unknown) {
    void _columns;
    void _opts;
    if (this.op !== "select") this.returning = true;
    return this;
  }
  eq(column: string, value: unknown) {
    this.filters.push((r) => r[column] === value);
    return this;
  }
  in(column: string, values: unknown[]) {
    this.filters.push((r) => values.includes(r[column]));
    return this;
  }
  not(column: string, op: string, value: unknown) {
    if (op === "is") this.filters.push((r) => (r[column] ?? null) !== value);
    return this;
  }
  gte(column: string, value: string | number) {
    this.filters.push((r) => (r[column] as string | number) >= value);
    return this;
  }
  lte(column: string, value: string | number) {
    this.filters.push((r) => (r[column] as string | number) <= value);
    return this;
  }
  order() {
    return this;
  }
  range() {
    return this;
  }
  limit() {
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  upsert(rows: Row | Row[], opts?: { onConflict?: string }) {
    this.op = "upsert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.onConflict = (opts?.onConflict ?? "id").split(",").map((c) => c.trim());
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }

  maybeSingle() {
    return this.run("maybe");
  }
  single() {
    return this.run("single");
  }
  then<T1, T2>(
    onfulfilled?: ((v: { data: unknown; error: { message: string } | null }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return this.run("many").then(onfulfilled, onrejected);
  }

  private async run(mode: "maybe" | "single" | "many"): Promise<{ data: unknown; error: { message: string } | null }> {
    const rows = this.db.rows(this.table);
    const match = (r: Row) => this.filters.every((f) => f(r));
    let result: Row[] = [];

    switch (this.op) {
      case "select":
        result = rows.filter(match).map((r) => ({ ...r }));
        this.db.fireHooks(this.table);
        break;
      case "insert": {
        for (const p of this.payload) {
          const row: Row = { id: this.db.nextId(this.table), ...p };
          rows.push(row);
          result.push({ ...row });
        }
        break;
      }
      case "upsert": {
        for (const p of this.payload) {
          const existing = rows.find((r) => this.onConflict.every((c) => r[c] === p[c]));
          if (existing) {
            Object.assign(existing, p);
            result.push({ ...existing });
          } else {
            const row: Row = { id: this.db.nextId(this.table), ...p };
            rows.push(row);
            result.push({ ...row });
          }
        }
        break;
      }
      case "update": {
        for (const r of rows.filter(match)) {
          Object.assign(r, this.patch);
          result.push({ ...r });
        }
        break;
      }
      case "delete": {
        result = rows.filter(match).map((r) => ({ ...r }));
        this.db.tables[this.table] = rows.filter((r) => !match(r));
        break;
      }
    }

    const returned = this.op === "select" || this.returning ? result : [];
    if (mode === "many") return { data: returned, error: null };
    if (mode === "maybe") return { data: returned[0] ?? null, error: null };
    return returned.length === 1
      ? { data: returned[0], error: null }
      : { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } };
  }
}

// ── project child counts, as migration 0049 defines them ──────────────────

const CHILD_TABLES = [
  "milestones",
  "tasks",
  "risks",
  "issues",
  "change_requests",
  "decisions",
  "rebaselines",
  "time_entries",
  "documents",
  "expenses",
  "allocations",
  "sprints",
] as const;

/** Mirrors nopm_project_child_counts (0049): one count per child table that hangs off a project. */
export function projectChildCounts(db: FakeDb, projectId: string): Record<string, number> {
  return Object.fromEntries(
    CHILD_TABLES.map((t) => [t, db.rows(t).filter((r) => r.project_id === projectId).length]),
  );
}

// ── the deletion-commit RPCs, as migration 0045 defines them ──────────────

const CHANNELS = new Set(["ui", "api", "cli", "mcp", "assistant", "lark"]);

function rpcError(code: string, message: string): RpcResult {
  return { data: null, error: { message, code } };
}

/** Mirrors nopm_commit_task_deletion / nopm_commit_project_deletion (0045): same guard order, same errcodes. */
export function commitDeletionRpc(args: Record<string, unknown>, db: FakeDb): RpcResult {
  const channel = (args.p_channel as string | null | undefined) ?? null;
  if (channel !== null && !CHANNELS.has(channel)) return rpcError("P0005", "INVALID_CHANNEL");

  const principal = (args.p_approver_principal_id as string | null | undefined) ?? null;
  if (!principal) return rpcError("P0006", "NO_PRINCIPAL");

  const reqs = db.rows("deletion_requests");
  const r = reqs.find((x) => x.id === args.p_request_id && x.workspace_id === args.p_workspace_id);
  if (!r) return rpcError("P0002", "NOT_FOUND");
  if (r.status !== "pending") return rpcError("P0001", "ALREADY_DECIDED");
  if (r.requested_by_id === args.p_approver_id) return rpcError("P0003", "SELF_APPROVAL");
  if (r.requested_principal_id && r.requested_principal_id === principal) return rpcError("P0003", "SELF_APPROVAL");

  const isProject = r.target_type === "project";
  if (isProject) {
    const proj = db.rows("projects").find((p) => p.id === r.target_id && p.workspace_id === args.p_workspace_id);
    if (proj?.is_locked) return rpcError("P0010", "PROJECT_LOCKED");
    // 0049: BEFORE DELETE trigger on projects — the scope recorded on the request must still hold.
    const expected = (r.before as { child_counts?: Record<string, number> } | null)?.child_counts;
    if (expected && JSON.stringify(projectChildCounts(db, r.target_id as string)) !== JSON.stringify(expected)) {
      return rpcError("P0016", "CHILDREN_CHANGED");
    }
    db.tables.projects = db.rows("projects").filter((p) => p.id !== r.target_id);
  } else {
    db.tables.tasks = db.rows("tasks").filter((t) => t.id !== r.target_id);
  }

  Object.assign(r, {
    status: "committed",
    approved_by_type: args.p_approver_type,
    approved_by_id: args.p_approver_id,
    approved_by_label: args.p_approver_label,
    approved_principal_id: principal,
  });

  const note = typeof args.p_note === "string" && args.p_note.trim() ? args.p_note.trim() : null;
  const base = {
    workspace_id: args.p_workspace_id,
    actor_type: args.p_approver_type,
    actor_id: args.p_approver_id,
    actor_label: args.p_approver_label,
    channel,
    request_id: args.p_correlation_id ?? null,
    via_connector_id: args.p_via_connector_id ?? null,
    external_event_id: args.p_external_event_id ?? null,
    external_actor_ref: args.p_external_actor_ref ?? null,
  };
  const audit = db.rows("audit_log");
  audit.push({
    ...base,
    id: db.nextId("audit_log"),
    action: isProject ? "project.delete" : "task.delete",
    target_type: r.target_type,
    target_id: r.target_id,
    before: r.before,
    after: null,
  });
  audit.push({
    ...base,
    id: db.nextId("audit_log"),
    action: "deletion_request.approved",
    target_type: "deletion_request",
    target_id: r.id,
    before: { status: "pending" },
    after: { status: "committed", approver_principal_id: principal, ...(note ? { note } : {}) },
  });

  return {
    data: {
      committed: true,
      request_id: r.id,
      requested_by_id: r.requested_by_id,
      requested_principal_id: r.requested_principal_id ?? null,
      target_type: r.target_type,
      target_id: r.target_id,
    },
    error: null,
  };
}
