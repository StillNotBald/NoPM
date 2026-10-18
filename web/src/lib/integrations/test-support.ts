/**
 * Test-only in-memory stand-in for the service-role Supabase client used by the
 * Integration Hub. It is NOT imported by any app code.
 *
 * Unlike a call-recording stub, this one keeps real rows and applies real
 * semantics: filters (eq/neq/in/is/lt/lte/gt/gte/not/or and `col->>key`),
 * ordering, limits, insert / update / delete with `.select()` returning the
 * affected rows, `maybeSingle` / `single`, and the migration's UNIQUE indexes
 * (including the partial ones) returning Postgres error code 23505. That lets
 * the hub's tests assert behaviour that depends on the database — atomic
 * single-use token consumption, idempotent claims, lease races — instead of
 * asserting the shape of calls.
 *
 * Each `update ... where ...` is applied atomically (JavaScript is single
 * threaded and the whole statement runs inside one synchronous step), which is
 * exactly the guarantee Postgres gives the conditional UPDATEs the hub relies on.
 */

import { mutateAuditedRpc } from "@/lib/governance/test-support/fake-mutate-audited";
import { encryptSecrets } from "@/lib/integrations/secrets";
import type { ApprovalEvent, ConnectorAdapter, ConnectorRow, DeliverResult, OutboundMessage } from "@/lib/integrations/types";

export type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;
type PgError = { code?: string; message: string };
type Result = { data: unknown; error: PgError | null; count: number | null };

type UniqueSpec = {
  name: string;
  cols: string[];
  where?: (row: Row) => boolean;
  /** Expression index: the computed key (null = never collides, like a SQL NULL). Replaces `cols`. */
  key?: (row: Row) => string | null;
};

const nowIso = () => new Date().toISOString();

/** Column defaults the real tables apply (migration 0046). */
const DEFAULTS: Record<string, () => Row> = {
  integration_connectors: () => ({
    status: "active",
    config: {},
    relay_secret_hash: null,
    tenant_key: null,
    created_by: null,
    created_at: nowIso(),
    updated_at: nowIso(),
    revoked_at: null,
  }),
  external_identities: () => ({
    provider: "lark",
    external_union_id: null,
    display_name: null,
    linked_at: nowIso(),
    revoked_at: null,
  }),
  identity_link_codes: () => ({ used_at: null, created_at: nowIso() }),
  integration_deliveries: () => ({
    approval_kind: null,
    approval_id: null,
    recipient_profile_id: null,
    external_target: null,
    parent_delivery_id: null,
    payload: {},
    status: "pending",
    attempts: 0,
    next_attempt_at: nowIso(),
    locked_until: null,
    external_message_id: null,
    last_error: null,
    created_at: nowIso(),
    sent_at: null,
  }),
  action_tokens: () => ({ used_at: null, created_at: nowIso() }),
  // The governed tables carry a content version their trigger bumps on every write.
  change_requests: () => ({ updated_at: nowIso() }),
  inbound_actions: () => ({
    approval_kind: null,
    approval_id: null,
    principal_id: null,
    outcome: null,
    received_at: nowIso(),
  }),
  audit_log: () => ({ created_at: nowIso() }),
  work_events: () => ({
    provider: "github",
    actor_login: null,
    task_id: null,
    received_at: nowIso(),
    applied: false,
    applied_status: null,
    reason: "received",
  }),
};

/** The unique indexes of migrations 0046, 0051 and 0053 (partial predicates included). */
const UNIQUES: Record<string, UniqueSpec[]> = {
  // 0101: one approval-timer event of each kind per request (the daily timer's once-only rule)
  approval_events: [{ name: "approval_events_once", cols: ["target_type", "target_id", "kind"] }],
  // 0096: one nudge per item per recipient per workspace day
  nudge_log: [
    { name: "nudge_log_once_per_day", cols: ["workspace_id", "kind", "target_type", "target_id", "recipient_id", "sent_on"] },
  ],
  integration_connectors: [
    { name: "uniq_live_connector_per_kind", cols: ["workspace_id", "kind"], where: (r) => r.status !== "revoked" },
  ],
  external_identities: [
    {
      name: "uniq_active_external_identity",
      cols: ["connector_id", "external_tenant", "external_user_id"],
      where: (r) => r.revoked_at == null,
    },
    { name: "uniq_active_profile_link", cols: ["connector_id", "profile_id"], where: (r) => r.revoked_at == null },
  ],
  identity_link_codes: [{ name: "code_hash_key", cols: ["code_hash"] }],
  integration_deliveries: [
    {
      name: "uniq_queued_approval_card",
      cols: ["connector_id", "approval_kind", "approval_id", "recipient_profile_id"],
      where: (r) => r.kind === "approval_card" && (r.status === "pending" || r.status === "retry"),
    },
    { name: "uniq_decision_update_per_card", cols: ["parent_delivery_id"], where: (r) => r.kind === "decision_update" },
    // 0053: one backlog roll-up per approver per hour
    {
      name: "uniq_backlog_notice_per_hour",
      cols: [],
      where: (r) =>
        r.kind === "bot_reply" && (r.payload as Row | null)?.notice === "backlog" && r.status !== "superseded",
      key: (r) => {
        const hour = (r.payload as Row | null)?.notice_hour;
        return typeof hour === "string" ? `${String(r.connector_id)}|${String(r.recipient_profile_id)}|${hour}` : null;
      },
    },
    // 0051: one live scheduled digest per connector per ISO week
    {
      name: "uniq_scheduled_digest_per_week",
      cols: [],
      where: (r) =>
        r.kind === "digest" &&
        (r.payload as Row | null)?.trigger === "scheduled" &&
        r.status !== "superseded",
      key: (r) => {
        const week = (r.payload as Row | null)?.week_start;
        return typeof week === "string" ? `${String(r.connector_id)}|${week}` : null;
      },
    },
  ],
  action_tokens: [{ name: "token_hash_key", cols: ["token_hash"] }],
  inbound_actions: [{ name: "inbound_actions_unique", cols: ["connector_id", "external_event_id"] }],
  // 0105: one work event per delivery per reference
  work_events: [{ name: "work_events_unique", cols: ["connector_id", "external_event_id", "ref"] }],
};

/** Read a column; `payload->>trigger` reads a text value out of a jsonb column. */
function read(row: Row, col: string): unknown {
  const arrow = col.indexOf("->>");
  if (arrow < 0) return row[col];
  const base = row[col.slice(0, arrow)] as Row | null | undefined;
  const v = base?.[col.slice(arrow + 3)];
  return v === undefined || v === null ? null : String(v);
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/** Parse the value half of a PostgREST filter string. */
function parseLiteral(raw: string): unknown {
  if (raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

function parseInList(raw: string): string[] {
  return raw
    .replace(/^\(/, "")
    .replace(/\)$/, "")
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter((s) => s.length > 0);
}

/** One `col.op.value` clause of an `.or()` / `.not()` expression. */
function clause(col: string, op: string, raw: string): Filter {
  switch (op) {
    case "eq":
      return (r) => read(r, col) === parseLiteral(raw);
    case "neq":
      return (r) => read(r, col) != null && read(r, col) !== parseLiteral(raw);
    case "is":
      return (r) => (parseLiteral(raw) === null ? read(r, col) == null : read(r, col) === parseLiteral(raw));
    case "lt":
      return (r) => read(r, col) != null && compare(read(r, col), raw) < 0;
    case "lte":
      return (r) => read(r, col) != null && compare(read(r, col), raw) <= 0;
    case "gt":
      return (r) => read(r, col) != null && compare(read(r, col), raw) > 0;
    case "gte":
      return (r) => read(r, col) != null && compare(read(r, col), raw) >= 0;
    case "in":
      return (r) => parseInList(raw).includes(String(read(r, col)));
    default:
      throw new Error(`FakeDb: unsupported filter operator "${op}"`);
  }
}

function parseOr(expr: string): Filter {
  const parts = expr.split(",").map((p) => {
    const first = p.indexOf(".");
    const second = p.indexOf(".", first + 1);
    return clause(p.slice(0, first), p.slice(first + 1, second), p.slice(second + 1));
  });
  return (r) => parts.some((f) => f(r));
}

export type FailRule = { table: string; op: "select" | "insert" | "update" | "delete"; error: PgError; times?: number };

export class FakeDb {
  tables: Record<string, Row[]> = {};
  /** Every statement executed, in order (table + op) — for "was X touched" assertions. */
  log: { table: string; op: string }[] = [];
  private failures: FailRule[] = [];
  private seq = 0;
  /** Simulates PostgREST's max_rows: a select never returns more than this many rows, whatever `limit` says. */
  maxRows: number | null = null;

  seed(table: string, rows: Row[]): this {
    this.tables[table] = [...(this.tables[table] ?? []), ...rows.map((r) => ({ ...r }))];
    return this;
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  /** Make the next `times` (default 1) matching statements fail with `error`. */
  failNext(rule: FailRule): void {
    this.failures.push({ times: 1, ...rule });
  }

  takeFailure(table: string, op: FailRule["op"]): PgError | null {
    const rule = this.failures.find((f) => f.table === table && f.op === op && (f.times ?? 1) > 0);
    if (!rule) return null;
    rule.times = (rule.times ?? 1) - 1;
    return rule.error;
  }

  nextId(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
  }

  from(table: string): FakeQuery {
    return new FakeQuery(this, table);
  }

  /** Set to make the next nopm_revoke_connector call fail BEFORE it changes anything (atomic: all or nothing). */
  failRevokeRpc: PgError | null = null;

  /**
   * RPCs. nopm_revoke_connector mirrors migration 0069 (one transaction: connector,
   * identities, deliveries, link codes and the audit row, or an error and no change).
   * Anything else is the rate limiter: always allowed.
   */
  async rpc(name?: string, args: Record<string, unknown> = {}): Promise<Result> {
    // Atomic audited write (migration 0103): mirrored by the governance test support, which only
    // needs rows(), nextId() and tables from the database it is handed.
    if (name === "nopm_mutate_audited") {
      const r = mutateAuditedRpc(args, this as unknown as Parameters<typeof mutateAuditedRpc>[1]);
      return { data: r.data, error: r.error, count: null } as Result;
    }
    // Migration 0105: a GitHub work event's status move, lock check and audit row in one transaction.
    if (name === "nopm_apply_task_status_from_event") {
      const task = this.rows("tasks").find((t) => t.id === args.p_task_id && t.workspace_id === args.p_workspace_id);
      if (!task) return { data: { result: "not_found" }, error: null, count: null };
      const audit = (args.p_audit ?? {}) as Row;
      const skip = (args.p_skip_audit ?? {}) as Row;
      const project = this.rows("projects").find((p) => p.id === task.project_id && p.workspace_id === args.p_workspace_id);
      const provenance = (a: Row) => ({
        actor_type: a.actor_type,
        actor_id: a.actor_id,
        actor_label: a.actor_label,
        channel: a.channel,
        request_id: a.request_id,
        via_connector_id: a.via_connector_id,
        external_event_id: a.external_event_id,
        external_actor_ref: a.external_actor_ref,
        workspace_id: args.p_workspace_id,
        target_type: "task",
        target_id: task.id,
      });
      if (project?.is_locked) {
        this.seed("audit_log", [
          { ...provenance(skip), action: "work_event.skipped", before: null, after: { ...((skip.after as Row) ?? {}), reason: "project_locked", project_id: task.project_id } },
        ]);
        return { data: { result: "project_locked" }, error: null, count: null };
      }
      if (args.p_expected_updated_at && task.updated_at !== args.p_expected_updated_at) {
        return { data: { result: "conflict" }, error: null, count: null };
      }
      const before = { ...task };
      task.status_type = args.p_status_type;
      // tasks.status is NOT NULL: a null label keeps the current one (mirrors the SQL)
      if (args.p_set_label && args.p_status_label != null) task.status = args.p_status_label;
      task.updated_at = nowIso();
      this.seed("audit_log", [{ ...provenance(audit), action: "task.update", before, after: { ...task } }]);
      return { data: { result: "applied", after: { ...task } }, error: null, count: null };
    }
    if (name === "nopm_revoke_connector") {
      if (this.failRevokeRpc) {
        const error = this.failRevokeRpc;
        this.failRevokeRpc = null;
        return { data: null, error, count: null };
      }
      const ws = args.p_workspace_id;
      const cid = args.p_connector_id;
      const connector = this.rows("integration_connectors").find((c) => c.id === cid && c.workspace_id === ws);
      if (!connector) return { data: null, error: { message: "CONNECTOR_NOT_FOUND" }, count: null };
      if (connector.status === "revoked") return { data: null, error: { message: "CONNECTOR_REVOKED" }, count: null };
      connector.status = "revoked";
      connector.revoked_at = args.p_revoked_at;
      let identities = 0;
      for (const i of this.rows("external_identities")) {
        if (i.workspace_id === ws && i.connector_id === cid && i.revoked_at === null) {
          i.revoked_at = args.p_revoked_at;
          identities += 1;
        }
      }
      let deliveries = 0;
      for (const d of this.rows("integration_deliveries")) {
        if (d.workspace_id === ws && d.connector_id === cid && (d.status === "pending" || d.status === "retry")) {
          d.status = "superseded";
          d.last_error = "connector revoked";
          deliveries += 1;
        }
      }
      this.tables.identity_link_codes = this.rows("identity_link_codes").filter(
        (c) => !(c.workspace_id === ws && c.connector_id === cid && c.used_at === null),
      );
      this.seed("audit_log", [
        {
          workspace_id: ws,
          action: "integration.connector.revoke",
          target_type: "integration_connector",
          target_id: cid,
          actor_id: args.p_actor_id,
          before: args.p_before,
          after: { ...(args.p_after as Row), identities_revoked: identities, deliveries_superseded: deliveries },
          channel: args.p_channel,
          request_id: args.p_correlation_id,
        },
      ]);
      return { data: { identities_revoked: identities, deliveries_superseded: deliveries }, error: null, count: null };
    }
    if (name === "nopm_update_workspace_settings") {
      // Mirrors migration 0101: pin check, write, and the audit row, or nothing.
      const err = (code: string, message: string) => ({ data: null, error: { code, message }, count: null });
      const ws = this.rows("workspaces").find((w) => w.id === args.p_workspace_id);
      if (!ws) return err("P0002", "NOT_FOUND");
      const expected = (args.p_expected ?? {}) as Row;
      for (const k of Object.keys(expected)) {
        if (JSON.stringify(ws[k] ?? null) !== JSON.stringify(expected[k])) return err("P0021", "STALE_ROW");
      }
      const before = { ...ws };
      Object.assign(ws, args.p_patch as Row);
      const a = (args.p_audit ?? {}) as Row;
      this.seed("audit_log", [
        {
          workspace_id: args.p_workspace_id,
          action: a.action,
          target_type: "workspace",
          target_id: args.p_workspace_id,
          actor_id: a.actor_id,
          before: a.before ?? null,
          after: a.after ?? null,
          channel: a.channel ?? null,
          request_id: a.request_id ?? null,
        },
      ]);
      return { data: { before, after: { ...ws } }, error: null, count: null };
    }
    return { data: { allowed: true, remaining: 999, retry_after_seconds: 0 }, error: null, count: null };
  }
}

class FakeQuery implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private payload: Row | Row[] | null = null;
  private filters: Filter[] = [];
  private orderBy: { col: string; asc: boolean } | null = null;
  private limitN: number | null = null;
  private rangeFrom = 0;
  private returning = false;
  private head = false;
  private wantCount = false;
  private cols: string[] | null = null;
  private singleMode: "maybe" | "one" | null = null;

  constructor(
    private db: FakeDb,
    private table: string,
  ) {}

  select(cols?: string, opts?: { count?: string; head?: boolean }): this {
    this.returning = true;
    // Column projection, so code that reads a column it did not select fails in tests too.
    if (cols && cols.trim() !== "*") this.cols = cols.split(",").map((c) => c.trim()).filter(Boolean);
    if (opts?.head) this.head = true;
    if (opts?.count) this.wantCount = true;
    return this;
  }
  insert(data: Row | Row[]): this {
    this.op = "insert";
    this.payload = data;
    return this;
  }
  update(patch: Row): this {
    this.op = "update";
    this.payload = patch;
    return this;
  }
  delete(): this {
    this.op = "delete";
    return this;
  }
  eq(col: string, v: unknown): this {
    this.filters.push((r) => read(r, col) === v);
    return this;
  }
  neq(col: string, v: unknown): this {
    this.filters.push((r) => read(r, col) != null && read(r, col) !== v);
    return this;
  }
  in(col: string, values: unknown[]): this {
    this.filters.push((r) => values.includes(read(r, col)));
    return this;
  }
  is(col: string, v: unknown): this {
    this.filters.push((r) => (v === null ? read(r, col) == null : read(r, col) === v));
    return this;
  }
  lt(col: string, v: unknown): this {
    this.filters.push((r) => read(r, col) != null && compare(read(r, col), v) < 0);
    return this;
  }
  lte(col: string, v: unknown): this {
    this.filters.push((r) => read(r, col) != null && compare(read(r, col), v) <= 0);
    return this;
  }
  gt(col: string, v: unknown): this {
    this.filters.push((r) => read(r, col) != null && compare(read(r, col), v) > 0);
    return this;
  }
  gte(col: string, v: unknown): this {
    this.filters.push((r) => read(r, col) != null && compare(read(r, col), v) >= 0);
    return this;
  }
  not(col: string, op: string, raw: string): this {
    // SQL `not (col op value)`: null columns stay excluded, matching PostgREST.
    const inner = clause(col, op, raw);
    this.filters.push((r) => read(r, col) != null && !inner(r));
    return this;
  }
  or(expr: string): this {
    this.filters.push(parseOr(expr));
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderBy = { col, asc: opts?.ascending !== false };
    return this;
  }
  /** PostgREST range(from, to): inclusive offsets, applied after ordering. */
  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.limitN = to - from + 1;
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  maybeSingle(): this {
    this.singleMode = "maybe";
    return this;
  }
  /** Singular result: exactly one row or an error (PostgREST PGRST116). */
  single(): this {
    this.singleMode = "one";
    return this;
  }

  then<A = Result, B = never>(
    onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  private matching(): Row[] {
    const all = this.db.rows(this.table);
    let rows = all.filter((r) => this.filters.every((f) => f(r)));
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      rows = [...rows].sort((a, b) => (asc ? 1 : -1) * compare(read(a, col), read(b, col)));
    }
    return rows;
  }

  private shape(rows: Row[]): Result {
    const out = rows.map((r) => {
      const copy = structuredClone(r);
      if (!this.cols) return copy;
      return Object.fromEntries(this.cols.map((c) => [c, copy[c] ?? null])) as Row;
    });
    if (this.singleMode === "maybe") {
      if (out.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" }, count: null };
      return { data: out[0] ?? null, error: null, count: null };
    }
    if (this.singleMode === "one") {
      if (out.length !== 1) return { data: null, error: { code: "PGRST116", message: "no single row" }, count: null };
      return { data: out[0], error: null, count: null };
    }
    return { data: out, error: null, count: null };
  }

  private run(): Result {
    const { table, db } = this;
    db.log.push({ table, op: this.op });
    const failure = db.takeFailure(table, this.op);
    if (failure) return { data: null, error: failure, count: null };

    if (this.op === "select") {
      let rows = this.matching();
      const total = rows.length;
      if (this.limitN !== null) rows = rows.slice(this.rangeFrom, this.rangeFrom + this.limitN);
      if (db.maxRows !== null) rows = rows.slice(0, db.maxRows);
      if (this.head) return { data: null, error: null, count: total };
      const shaped = this.shape(rows);
      return this.wantCount ? { ...shaped, count: total } : shaped;
    }

    if (this.op === "insert") {
      const incoming = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      const built: Row[] = incoming.map((r) => ({ id: db.nextId(), ...(DEFAULTS[table]?.() ?? {}), ...r }));
      const existing = db.rows(table);
      const accepted: Row[] = [];
      for (const row of built) {
        for (const spec of UNIQUES[table] ?? []) {
          if (spec.where && !spec.where(row)) continue;
          const mine = spec.key ? spec.key(row) : null;
          const clash = [...existing, ...accepted].some(
            (other) =>
              (!spec.where || spec.where(other)) &&
              (spec.key
                ? mine !== null && spec.key(other) === mine
                : spec.cols.every((c) => other[c] === row[c] && row[c] != null)),
          );
          if (clash) {
            return {
              data: null,
              error: { code: "23505", message: `duplicate key value violates unique constraint "${spec.name}"` },
              count: null,
            };
          }
        }
        accepted.push(row);
      }
      db.tables[table] = [...existing, ...accepted];
      return this.returning ? this.shape(accepted) : { data: null, error: null, count: null };
    }

    if (this.op === "update") {
      const hit = this.matching();
      for (const row of hit) Object.assign(row, this.payload as Row);
      return this.returning ? this.shape(hit) : { data: null, error: null, count: null };
    }

    // delete
    const hit = this.matching();
    db.tables[table] = db.rows(table).filter((r) => !hit.includes(r));
    return this.returning ? this.shape(hit) : { data: null, error: null, count: null };
  }
}

// ── shared fixtures ─────────────────────────────────────────────────────────

export const WS = "11111111-1111-4111-8111-111111111111";
export const OTHER_WS = "22222222-2222-4222-8222-222222222222";
/** The content version (updated_at) the seeded change request starts at. */
export const REQUEST_VERSION = "2026-10-16T08:00:00.000Z";
export const CONNECTOR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

export const ids = {
  admin: "a0000000-0000-4000-8000-000000000001",
  manager: "a0000000-0000-4000-8000-000000000002",
  manager2: "a0000000-0000-4000-8000-000000000003",
  member: "a0000000-0000-4000-8000-000000000004",
  viewer: "a0000000-0000-4000-8000-000000000005",
  requester: "a0000000-0000-4000-8000-000000000006",
  approval: "b0000000-0000-4000-8000-000000000001",
};

export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
export const APP_SECRET = "app-secret-value-123";
export const VERIFICATION_TOKEN = "verification-token-456";

/** A connector row as the server loads it. Needs NOPM_ENCRYPTION_KEY stubbed first. */
export function connectorRow(overrides: Partial<ConnectorRow> = {}): ConnectorRow {
  return {
    id: CONNECTOR_ID,
    workspace_id: WS,
    kind: "lark",
    name: "Team Lark",
    status: "active",
    config: {
      region: "lark",
      appId: "cli_a1b2c3",
      mode: "webhook",
      approvals: { enabled: true },
      digest: { enabled: false, chatId: null, weekday: 1 },
    },
    secret_enc: encryptSecrets({ appSecret: APP_SECRET, verificationToken: VERIFICATION_TOKEN, encryptKey: null }),
    relay_secret_hash: "relayhash",
    tenant_key: null,
    created_by: ids.admin,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    revoked_at: null,
    ...overrides,
  };
}

/** Standard workspace: one active connector + admin/manager/member/viewer profiles. */
export function seedWorkspace(db: FakeDb, connector: ConnectorRow = connectorRow()): ConnectorRow {
  db.seed("integration_connectors", [connector as unknown as Row]);
  db.seed("workspaces", [{ id: WS, name: "Acme PMO" }]);
  db.seed("profiles", [
    { id: ids.admin, workspace_id: WS, role: "admin", display_name: "Ada Admin", email: "ada@example.test" },
    { id: ids.manager, workspace_id: WS, role: "manager", display_name: "Max Manager", email: "max@example.test" },
    { id: ids.manager2, workspace_id: WS, role: "manager", display_name: "Mia Manager", email: "mia@example.test" },
    { id: ids.member, workspace_id: WS, role: "member", display_name: "Mo Member", email: "mo@example.test" },
    { id: ids.viewer, workspace_id: WS, role: "viewer", display_name: "Vi Viewer", email: "vi@example.test" },
    { id: ids.requester, workspace_id: WS, role: "manager", display_name: "Rae Requester", email: "rae@example.test" },
  ]);
  seedPendingRequests(db);
  return connector;
}

/**
 * The governed requests behind `ids.approval`, all still awaiting a decision
 * (one per source table, same id). A card is only sent for a request that is
 * pending, so a drain test needs the row to exist. Flip `status` to simulate
 * a decision that landed meanwhile.
 */
export function seedPendingRequests(db: FakeDb, id: string = ids.approval, workspaceId: string = WS): void {
  db.seed("deletion_requests", [{ id, workspace_id: workspaceId, status: "pending", target_type: "task" }]);
  db.seed("change_requests", [{ id, workspace_id: workspaceId, status: "raised", updated_at: REQUEST_VERSION }]);
}

/** Link a profile to a platform user on the standard connector. */
export function linkIdentity(db: FakeDb, profileId: string, externalUserId: string, tenant = "tenant-1"): Row {
  const row = {
    id: db.nextId(),
    workspace_id: WS,
    connector_id: CONNECTOR_ID,
    provider: "lark",
    external_tenant: tenant,
    external_user_id: externalUserId,
    external_union_id: null,
    display_name: null,
    profile_id: profileId,
    linked_at: "2026-10-02T00:00:00.000Z",
    revoked_at: null,
  };
  db.seed("external_identities", [row]);
  return row;
}

export type FakeAdapterCalls = {
  cards: { ev: ApprovalEvent; ctx: { actionToken: string; appUrl: string } }[];
  updates: { externalMessageId: string; body: Record<string, unknown> }[];
  sends: OutboundMessage[];
};

/** A platform adapter that records what it was asked to do and can be told to fail. */
export function createFakeAdapter() {
  const calls: FakeAdapterCalls = { cards: [], updates: [], sends: [] };
  const state: { sendResult: () => Promise<DeliverResult>; updateResult: () => Promise<DeliverResult> } = {
    sendResult: async () => ({ ok: true, externalMessageId: `om_${calls.sends.length}` }),
    updateResult: async () => ({ ok: true, externalMessageId: null }),
  };
  const adapter: ConnectorAdapter = {
    kind: "lark",
    renderApprovalCard: (ev, ctx) => {
      calls.cards.push({ ev, ctx });
      return { card: "approval", title: ev.title, button: { t: ctx.actionToken } };
    },
    renderDecisionUpdate: (ev) => ({ card: "decided", status: ev.status }),
    renderDigest: (data) => ({ card: "digest", projects: data.projects.length }),
    renderChangedUpdate: (ev) => ({ card: "changed", title: ev.title }),
    renderBacklogNotice: (ctx) => ({ card: "backlog", waiting: ctx.waiting, limit: ctx.limit }),
    send: async (_connector, _secrets, msg) => {
      calls.sends.push(msg);
      return state.sendResult();
    },
    update: async (_connector, _secrets, externalMessageId, body) => {
      calls.updates.push({ externalMessageId, body });
      return state.updateResult();
    },
    testConnection: async () => ({ ok: true, botName: "NoPM Bot" }),
  };
  return { adapter, calls, state };
}
