/**
 * In-memory mirrors of the wave-5 governance functions of migration 0108 (nopm_request_deletion,
 * nopm_withdraw_deletion_request, nopm_reject_deletion_request, nopm_raise_change_request, nopm_edit_change_request,
 * nopm_withdraw_change_request, nopm_propose_rebaseline), for the route and library unit tests that call them
 * through atomic-rpc.ts. Test support only: nothing in the app imports it.
 *
 * Same guard ORDER, error codes and error text as the SQL, so the TypeScript error mapping is exercised against
 * the contract the database enforces. Each call is a transaction: it either applies every write (change, audit row,
 * ledger event) or none, and `db.mutateFailure` makes the audit step fail AFTER the change was applied, so a test can
 * prove that no orphan row survives. The SQL itself is covered by the migration-text test and the local-DB probe
 * (scripts/local-db/probe-atomic-governance.mjs).
 */
import { projectChildCounts } from "./fake-admin";
import type { FakeDb, Row, RpcHandler, RpcResult } from "./fake-admin";

const CHANNELS = new Set(["ui", "api", "cli", "mcp", "assistant", "lark", "github"]);

const ENTITY_TABLE: Record<string, string> = {
  task: "tasks",
  project: "projects",
  risk: "risks",
  issue: "issues",
  expense: "expenses",
  document: "documents",
  milestone: "milestones",
  program: "programs",
  sprint: "sprints",
  resource: "resource_members",
  allocation: "allocations",
  clash: "clashes",
};

const err = (code: string, message: string): RpcResult => ({ data: null, error: { message, code } });
const ok = (data: unknown): RpcResult => ({ data, error: null });
const isObj = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);

/** One database transaction: every write of `fn` stands, or (on an error result) none does. */
function atomic(db: FakeDb, fn: () => RpcResult): RpcResult {
  const snapshot = structuredClone(db.tables);
  const result = fn();
  if (result.error) db.tables = snapshot;
  return result;
}

/** Mirrors nopm_audit_insert: validates the channel, then writes one audit row (or fails like a broken audit step). */
function insertAudit(
  db: FakeDb,
  workspaceId: unknown,
  audit: Row,
  targetId: unknown,
  before: unknown,
  after: unknown,
): RpcResult | null {
  const channel = (audit.channel as string | null | undefined) ?? null;
  if (channel !== null && !CHANNELS.has(channel)) return err("P0005", "INVALID_CHANNEL");
  if (db.mutateFailure) return err(db.mutateFailure.code, db.mutateFailure.message);
  db.rows("audit_log").push({
    id: db.nextId("audit_log"),
    workspace_id: workspaceId,
    actor_type: audit.actor_type,
    actor_id: audit.actor_id,
    actor_label: audit.actor_label,
    action: audit.action,
    target_type: audit.target_type,
    target_id: targetId,
    before: before ?? null,
    after: after ?? null,
    channel,
    request_id: audit.request_id ?? null,
    principal_id: audit.principal_id ?? null,
    via_connector_id: audit.via_connector_id ?? null,
    external_event_id: audit.external_event_id ?? null,
    external_actor_ref: audit.external_actor_ref ?? null,
  });
  return null;
}

/** The deadline_set ledger event (fail-soft in SQL; one per target and kind). */
function deadlineEvent(db: FakeDb, workspaceId: unknown, targetType: string, targetId: unknown, audit: Row, detail: unknown): void {
  const rows = db.rows("approval_events");
  if (rows.some((e) => e.target_type === targetType && e.target_id === targetId && e.kind === "deadline_set")) return;
  rows.push({
    id: db.nextId("approval_events"),
    workspace_id: workspaceId,
    target_type: targetType,
    target_id: targetId,
    kind: "deadline_set",
    actor_label: audit.actor_label,
    detail: detail ?? null,
  });
}

const actionGuard = (audit: unknown, wanted: string): RpcResult | null =>
  isObj(audit) && audit.action === wanted ? null : err("P0059", `INVALID_AUDIT: action must be ${wanted}`);

// ── deletion requests ──────────────────────────────────────────────────────────────────────────

export const requestDeletionRpc: RpcHandler = (args, db) =>
  atomic(db, () => {
    const ws = args.p_workspace_id;
    const entity = String(args.p_entity);
    const id = args.p_target_id as string;
    const audit = (args.p_audit ?? {}) as Row;
    if (!args.p_requested_principal_id) return err("P0006", "NO_PRINCIPAL");
    const bad = actionGuard(audit, `${entity}.delete_requested`);
    if (bad) return bad;
    const table = ENTITY_TABLE[entity];
    if (!table) return err("P0060", `UNSUPPORTED_ENTITY: ${entity}`);
    const target = db.rows(table).find((r) => r.id === id && r.workspace_id === ws);
    if (!target) return err("P0002", "NOT_FOUND");

    if (entity === "project" || entity === "task" || entity === "milestone") {
      const pid = entity === "project" ? id : (target.project_id as string | undefined);
      const proj = pid ? db.rows("projects").find((p) => p.id === pid && p.workspace_id === ws) : undefined;
      if (proj?.is_locked) return err("P0010", "PROJECT_LOCKED");
    }

    let before: Row = { ...target };
    if (entity === "project") before = { ...before, child_counts: projectChildCounts(db, id) };
    if (entity === "milestone") {
      before = { ...before, child_counts: { tasks: db.rows("tasks").filter((t) => t.workspace_id === ws && t.milestone_id === id).length } };
    }

    // 0113: the child counts the approver is shown (nopm_deletion_entities.child_count_sql).
    if (entity === "program") {
      before = { ...before, child_counts: { projects: db.rows("projects").filter((p) => p.workspace_id === ws && p.program_id === id).length } };
    }
    if (entity === "sprint") {
      before = { ...before, child_counts: { tasks: db.rows("tasks").filter((t) => t.workspace_id === ws && t.sprint_id === id).length } };
    }
    if (entity === "allocation") {
      const name = (table: string, key: unknown) => db.rows(table).find((r) => r.id === key)?.name as string | undefined;
      const when = target.window_start ? [target.window_start, target.window_end].filter(Boolean).join(" to ") : undefined;
      const display = [name("resource_members", target.member_id), name("projects", target.project_id), name("tasks", target.task_id), when]
        .filter(Boolean)
        .join(" · ");
      before = { ...before, child_counts: { display_name: display } };
    }
    if (entity === "resource") {
      const allocs = db.rows("allocations").filter((a) => a.workspace_id === ws && a.member_id === id);
      before = {
        ...before,
        child_counts: {
          allocations: allocs.length,
          allocation_ids: allocs.map((a) => a.id).sort(),
          assigned_tasks: db.rows("tasks").filter((t) => t.workspace_id === ws && t.assignee_id === id).length,
        },
      };
    }

    if (db.rows("deletion_requests").some((r) => r.target_type === entity && r.target_id === id && r.status === "pending")) {
      return err("23505", 'duplicate key value violates unique constraint "uniq_pending_deletion"');
    }
    const row: Row = {
      id: db.nextId("deletion_requests"),
      workspace_id: ws,
      target_type: entity,
      target_id: id,
      reason: args.p_reason,
      status: "pending",
      tier: args.p_tier ?? "normal",
      approval_deadline_at: args.p_deadline ?? null,
      requested_by_type: args.p_requested_by_type,
      requested_by_id: args.p_requested_by_id,
      requested_by_label: args.p_requested_by_label,
      requested_principal_id: args.p_requested_principal_id,
      before,
      ...(args.p_assigned_approver_id ? { assigned_approver_id: args.p_assigned_approver_id } : {}),
    };
    db.rows("deletion_requests").push(row);
    const failed = insertAudit(db, ws, audit, id, before, args.p_assigned_approver_id ? { assigned_approver_id: args.p_assigned_approver_id } : null);
    if (failed) return failed;
    deadlineEvent(db, ws, "deletion_request", row.id, audit, args.p_event_detail);
    return ok({ ...row });
  });

export const withdrawDeletionRpc: RpcHandler = (args, db) =>
  atomic(db, () => {
    const ws = args.p_workspace_id;
    const audit = (args.p_audit ?? {}) as Row;
    const bad = actionGuard(audit, "deletion_request.withdrawn");
    if (bad) return bad;
    const r = db.rows("deletion_requests").find((x) => x.id === args.p_request_id && x.workspace_id === ws);
    if (!r) return err("P0002", "NOT_FOUND");
    if (r.status !== "pending") return err("P0001", "ALREADY_DECIDED");
    r.status = "withdrawn";
    r.decided_at = new Date().toISOString();
    if (args.p_closed_reason) r.closed_reason = args.p_closed_reason;
    const reason = (args.p_closed_reason as string | null | undefined) ?? null;
    const failed = insertAudit(db, ws, audit, r.id, { status: "pending" }, reason === null ? { status: "withdrawn" } : { status: "withdrawn", reason });
    if (failed) return failed;
    return ok({ id: r.id, status: r.status });
  });

export const rejectDeletionRpc: RpcHandler = (args, db) =>
  atomic(db, () => {
    const ws = args.p_workspace_id;
    const audit = (args.p_audit ?? {}) as Row;
    if (!args.p_approver_principal_id) return err("P0006", "NO_PRINCIPAL");
    const bad = actionGuard(audit, "deletion_request.rejected");
    if (bad) return bad;
    const r = db.rows("deletion_requests").find((x) => x.id === args.p_request_id && x.workspace_id === ws);
    if (!r) return err("P0002", "NOT_FOUND");
    if (r.status !== "pending") return err("P0001", "ALREADY_DECIDED");
    Object.assign(r, {
      status: "rejected",
      approved_by_type: args.p_approver_type,
      approved_by_id: args.p_approver_id,
      approved_by_label: args.p_approver_label,
      approved_principal_id: args.p_approver_principal_id,
      decided_at: new Date().toISOString(),
    });
    const failed = insertAudit(db, ws, audit, r.id, { status: "pending" }, {
      status: "rejected",
      approver_principal_id: args.p_approver_principal_id,
      reason: args.p_reason,
    });
    if (failed) return failed;
    return ok({ id: r.id, status: r.status });
  });

// ── change requests ────────────────────────────────────────────────────────────────────────────

export const raiseChangeRequestRpc: RpcHandler = (args, db) =>
  atomic(db, () => {
    const ws = args.p_workspace_id;
    const input = (args.p_input ?? {}) as Row;
    const audit = (args.p_audit ?? {}) as Row;
    if (!args.p_principal_id) return err("P0006", "NO_PRINCIPAL");
    if (!args.p_tier || args.p_tier === "emergency") return err("P0061", "EMERGENCY_VIA_OTHER_FUNCTION");
    const bad = actionGuard(audit, "change_request.create");
    if (bad) return bad;
    if (!db.rows("projects").some((p) => p.id === input.project_id && p.workspace_id === ws)) return err("P0002", "NOT_FOUND");
    const row: Row = {
      id: db.nextId("change_requests"),
      workspace_id: ws,
      ...input,
      status: input.status ?? "raised",
      tier: args.p_tier,
      approval_deadline_at: args.p_deadline ?? null,
      requested_principal_id: args.p_principal_id,
      updated_at: new Date().toISOString(),
      ...(args.p_assigned_approver_id ? { assigned_approver_id: args.p_assigned_approver_id } : {}),
    };
    db.rows("change_requests").push(row);
    const failed = insertAudit(db, ws, audit, row.id, null, { ...row });
    if (failed) return failed;
    deadlineEvent(db, ws, "change_request", row.id, audit, args.p_event_detail);
    return ok({ ...row });
  });

const OPEN = new Set(["raised", "under_review"]);

function openOwnRow(args: Record<string, unknown>, db: FakeDb, wantedAction: string): { row?: Row; fail?: RpcResult } {
  const audit = (args.p_audit ?? {}) as Row;
  if (!args.p_editor_principal) return { fail: err("P0006", "NO_PRINCIPAL") };
  const bad = actionGuard(audit, wantedAction);
  if (bad) return { fail: bad };
  const row = db.rows("change_requests").find((c) => c.id === args.p_id && c.workspace_id === args.p_workspace_id);
  if (!row) return { fail: err("P0002", "NOT_FOUND") };
  if (!OPEN.has(String(row.status))) return { fail: err("P0001", "CR_DECIDED") };
  if (row.requested_principal_id && row.requested_principal_id !== args.p_editor_principal) return { fail: err("P0023", "NOT_REQUESTER") };
  return { row };
}

export const editChangeRequestRpc: RpcHandler = (args, db) =>
  atomic(db, () => {
    const { row, fail } = openOwnRow(args, db, "change_request.update");
    if (fail || !row) return fail as RpcResult;
    const before = { ...row };
    const updates = (isObj(args.p_updates) ? args.p_updates : {}) as Row;
    Object.assign(row, updates);
    if (Object.keys(updates).length > 0) row.updated_at = new Date().toISOString();
    const after = { ...row };
    const failed = insertAudit(db, args.p_workspace_id, (args.p_audit ?? {}) as Row, row.id, before, after);
    if (failed) return failed;
    return ok(after);
  });

export const withdrawChangeRequestRpc: RpcHandler = (args, db) =>
  atomic(db, () => {
    const { row, fail } = openOwnRow(args, db, "change_request.delete");
    if (fail || !row) return fail as RpcResult;
    const before = { ...row };
    db.tables.change_requests = db.rows("change_requests").filter((c) => c !== row);
    const failed = insertAudit(db, args.p_workspace_id, (args.p_audit ?? {}) as Row, row.id, before, null);
    if (failed) return failed;
    return ok(before);
  });

// ── rebaselines ────────────────────────────────────────────────────────────────────────────────

const noNote = (v: unknown) => v === undefined || v === null || v === "";

export const proposeRebaselineRpc: RpcHandler = (args, db) =>
  atomic(db, () => {
    const ws = args.p_workspace_id;
    const audit = (args.p_audit ?? {}) as Row;
    if (!args.p_principal_id) return err("P0006", "NO_PRINCIPAL");
    const bad = actionGuard(audit, "rebaseline.create");
    if (bad) return bad;
    const project = db.rows("projects").find((p) => p.id === args.p_project_id && p.workspace_id === ws);
    if (!project) return err("P0002", "NOT_FOUND");
    if (!project.is_locked) return err("P0019", "PROJECT_NOT_LOCKED");
    const mine = db.rows("rebaselines").filter((r) => r.project_id === args.p_project_id && r.workspace_id === ws);
    const version = mine.reduce((m, r) => Math.max(m, Number(r.version ?? 0)), 0) + 1;
    if (mine.some((r) => r.status === "pending_approval")) {
      return err("23505", 'duplicate key value violates unique constraint "uniq_pending_rebaseline"');
    }
    const dates = (start: unknown, target: unknown, note: unknown): Row =>
      noNote(note) ? { start_date: start ?? null, target_date: target ?? null } : { start_date: start ?? null, target_date: target ?? null, note };
    const row: Row = {
      id: db.nextId("rebaselines"),
      workspace_id: ws,
      project_id: args.p_project_id,
      version,
      status: "pending_approval",
      tier: args.p_tier,
      approval_deadline_at: args.p_deadline ?? null,
      reason: args.p_reason,
      requested_by: args.p_requested_by ?? null,
      requested_principal_id: args.p_principal_id,
      before: dates(project.baseline_start_date, project.baseline_target_date, args.p_note_before),
      after: dates(project.start_date, project.target_date, args.p_note_after),
      created_at: new Date().toISOString(),
      ...(args.p_assigned_approver_id ? { assigned_approver_id: args.p_assigned_approver_id } : {}),
    };
    db.rows("rebaselines").push(row);
    const failed = insertAudit(db, ws, audit, row.id, null, { ...row });
    if (failed) return failed;
    deadlineEvent(db, ws, "rebaseline", row.id, audit, {
      tier: args.p_tier,
      deadline: args.p_deadline ?? null,
    });
    return ok({ ...row });
  });

/** All seven handlers, keyed by function name. Register with installAtomicGovernance(db) or spread into FakeDb.rpcHandlers. */
export const atomicGovernanceHandlers: Record<string, RpcHandler> = {
  nopm_request_deletion: requestDeletionRpc,
  nopm_withdraw_deletion_request: withdrawDeletionRpc,
  nopm_reject_deletion_request: rejectDeletionRpc,
  nopm_raise_change_request: raiseChangeRequestRpc,
  nopm_edit_change_request: editChangeRequestRpc,
  nopm_withdraw_change_request: withdrawChangeRequestRpc,
  nopm_propose_rebaseline: proposeRebaselineRpc,
};

/**
 * Register the handlers on an in-memory database a test builds itself. Works for this folder's FakeDb (which has an
 * rpcHandlers table) and for the integrations FakeDb (whose rpc() is a method, so it is wrapped). Returns the same db.
 */
export function installAtomicGovernance<T extends object>(db: T): T {
  if ("rpcHandlers" in db) {
    Object.assign((db as unknown as FakeDb).rpcHandlers, atomicGovernanceHandlers);
    return db;
  }
  const target = db as unknown as {
    rpc: (name?: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  const inner = target.rpc.bind(db);
  target.rpc = async (name?: string, args: Record<string, unknown> = {}) => {
    const handler = name ? atomicGovernanceHandlers[name] : undefined;
    if (!handler) return inner(name, args);
    const r = await handler(args, db as unknown as FakeDb);
    return { ...r, count: null };
  };
  return db;
}
