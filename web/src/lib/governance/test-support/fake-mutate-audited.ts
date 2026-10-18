/**
 * In-memory mirror of nopm_mutate_audited (migration 0103) for route tests:
 * same guard order and error messages as the SQL, one audit row per call, and
 * a write that is skipped entirely when a guard fails (the transaction).
 * Test support only.
 */
import type { FakeDb, Row, RpcResult } from "./fake-admin";

export const MUTATE_ALLOWED = new Set([
  "projects", "milestones", "tasks", "risks", "issues", "clashes", "programs",
  "sprints", "allocations", "expenses", "resource_members", "saved_views",
  "calendar_feeds", "documents", "decisions", "invites", "api_tokens",
  "notifications", "integration_connectors", "external_identities",
  "assistant_credentials", "project_budget", "profiles",
  "project_dependencies", "task_dependencies",
]);
const FORBIDDEN = new Set(["id", "workspace_id", "created_at"]);
/** Mirrors the narrowed rows of nopm_mutate_audited_tables (migration 0103). */
const COLUMNS: Record<string, { insert?: string[]; update?: string[] }> = {
  profiles: { insert: [], update: ["display_name", "avatar_url"] },
  api_tokens: { update: ["label", "revoked", "revoked_at", "expires_at", "last_used_at"] },
  invites: { update: ["revoked", "revoked_at", "expires_at", "renewed_at", "status"] },
  assistant_credentials: { update: ["provider", "model", "api_key_enc", "updated_at"] },
};

const err = (code: string, message: string): RpcResult => ({ data: null, error: { message, code } });

export function mutateAuditedRpc(args: Record<string, unknown>, db: FakeDb): RpcResult {
  const table = args.p_table as string;
  const op = args.p_op as string;
  const ws = args.p_workspace_id as string;
  const id = (args.p_id as string | null) ?? null;
  const patch = ((args.p_patch as Row | null) ?? {}) as Row;
  const audit = (args.p_audit as Record<string, unknown>) ?? {};

  if (!MUTATE_ALLOWED.has(table)) return err("P0053", `TABLE_NOT_ALLOWED: ${table}`);
  if (!["insert", "update", "delete"].includes(op)) return err("P0055", "INVALID_OP");
  for (const k of Object.keys(patch)) {
    if (FORBIDDEN.has(k)) return err("P0054", `FORBIDDEN_COLUMN: ${k}`);
    const allowed = op === "insert" ? COLUMNS[table]?.insert : op === "update" ? COLUMNS[table]?.update : undefined;
    if (allowed && !allowed.includes(k)) return err("P0054", `FORBIDDEN_COLUMN: ${table}.${k}`);
  }
  const failure = db.mutateFailure;
  if (failure) return err(failure.code, failure.message);

  const rows = db.rows(table);
  const keyCol = table === "project_budget" ? "project_id" : "id";
  let before: Row | null = null;
  let after: Row | null = null;
  let target: unknown = id;

  if (op === "insert") {
    const row: Row = { [keyCol]: id ?? db.nextId(table), ...patch, workspace_id: ws };
    rows.push(row);
    after = { ...row };
    target = row[keyCol];
  } else {
    const row = rows.find((r) => r[keyCol] === id && r.workspace_id === ws);
    if (!row) return err("P0002", "NOT_FOUND");
    before = { ...row };
    const expected = args.p_expected_updated_at as string | null;
    if (expected && !("updated_at" in row)) return err("P0056", `NO_UPDATED_AT: ${table} has no updated_at to compare`);
    if (expected && Date.parse(String(row.updated_at)) !== Date.parse(expected)) return err("P0051", "STALE_ROW");
    const cas = audit.require_null as string | undefined;
    if (cas && row[cas] !== null && row[cas] !== undefined) return err("P0051", "STALE_ROW");
    if (op === "update") {
      Object.assign(row, patch);
      after = { ...row };
    } else {
      db.tables[table] = rows.filter((r) => r !== row);
    }
  }

  const omit = (r: Row | null): Row | null => {
    if (!r) return r;
    const out = { ...r };
    for (const k of (audit.omit_columns as string[] | undefined) ?? []) delete out[k];
    return out;
  };
  db.rows("audit_log").push({
    id: db.nextId("audit_log"),
    workspace_id: ws,
    actor_type: audit.actor_type,
    actor_id: audit.actor_id,
    actor_label: audit.actor_label,
    action: audit.action,
    target_type: audit.target_type ?? table,
    target_id: audit.target_id ?? target,
    before: omit("before" in audit ? (audit.before as Row | null) : before),
    after: omit("after" in audit ? (audit.after as Row | null) : after && audit.after_extra ? { ...after, ...(audit.after_extra as Row) } : after),
    channel: audit.channel ?? null,
    request_id: audit.request_id ?? null,
    principal_id: audit.principal_id ?? null,
    via_connector_id: audit.via_connector_id ?? null,
    external_event_id: audit.external_event_id ?? null,
    external_actor_ref: audit.external_actor_ref ?? null,
  });
  return { data: { before: omit(before), after: omit(after) }, error: null };
}
