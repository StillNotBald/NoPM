import type { createAdminClient } from "@/lib/supabase/admin";
import type { Actor } from "@/lib/auth/guard";
import { ConflictError, NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { buildRpcAudit } from "@/lib/audit/sql-audit-insert";
import { LOCK_FIRST_MESSAGE, PENDING_REBASELINE_EXISTS_MESSAGE } from "@/lib/governance/rebaseline-rpc";
import { NO_MAKER_PRINCIPAL_MESSAGE } from "@/lib/governance/decide";

/**
 * Thin callers for the wave-5 governance RPCs of migration 0108. Each database function writes the change AND its
 * audit row (through nopm_audit_insert) in one transaction; these helpers build the arguments, call it through
 * the admin client and turn the database error codes into the same API errors the routes threw before.
 *
 * Business rules that decide WHO may do WHAT (scopes, maker principal, tier from the policy, assigned approver,
 * the project-lock and approved-records pre-checks) stay in the callers; the functions repeat only the races.
 */
type Db = ReturnType<typeof createAdminClient>;
export type RpcErr = { message?: string | null; code?: string | null; details?: string | null };
// The database answers rows as jsonb; callers read them as the untyped admin client does (same as next-ref.ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

/** The `after`-less audit object every function receives as `p_audit`. */
function audit(actor: Actor, action: string, targetType: string): Record<string, unknown> {
  return buildRpcAudit(actor, action, targetType);
}

/**
 * The error carries the token the function raised. The SQLSTATE alone is not enough: P0001 is also what PL/pgSQL
 * raises for any plain `raise exception`, so an unrelated failure must not read as "already decided". An error
 * with no known token falls through to a plain Error (a 500). `code` is kept only to document the pairing.
 */
function has(e: RpcErr, token: string, _code: string): boolean {
  void _code;
  return (e.message ?? "").includes(token);
}

const INVALID_ASSIGNEE_MESSAGE = "assigned_approver_id must be a manager or admin of this workspace";
function invalidAssignee(e: RpcErr): void {
  if (has(e, "INVALID_ASSIGNEE", "P0064")) throw new RuleError(INVALID_ASSIGNEE_MESSAGE, "invalid_assigned_approver");
}

function unwrap<T>(res: { data: unknown; error: RpcErr | null }, fn: string, map: (e: RpcErr) => never): T {
  if (res.error) return map(res.error);
  if (res.data === null || res.data === undefined) throw new Error(`${fn} returned no row`);
  return res.data as T;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// One constant per audit action, so the drift guard (action-glossary.test.ts) and a text search both find them.
const DELETION_WITHDRAWN_AUDIT_ACTION = "deletion_request.withdrawn";
const DELETION_REJECTED_AUDIT_ACTION = "deletion_request.rejected";
const CHANGE_REQUEST_CREATE_AUDIT_ACTION = "change_request.create";
const CHANGE_REQUEST_UPDATE_AUDIT_ACTION = "change_request.update";
const CHANGE_REQUEST_DELETE_AUDIT_ACTION = "change_request.delete";
const REBASELINE_CREATE_AUDIT_ACTION = "rebaseline.create";

// ── deletion requests ──────────────────────────────────────────────────────────────────────────

export const PROJECT_LOCKED_MESSAGE =
  "Project is locked (baseline frozen) — ask a manager or admin to unlock it, or propose a rebaseline.";

export type RequestDeletionArgs = {
  actor: Actor;
  entity: string;
  /** The audit action, written out at the call site so a text search finds it: "<entity>.delete_requested". */
  action: string;
  targetId: string;
  reason: string;
  tier: string;
  deadline: Date | null;
  assignedApproverId: string | null;
  requesterPrincipal: string;
};

/**
 * nopm_request_deletion: the deletion_requests row, `<entity>.delete_requested` and the deadline_set event in one
 * transaction. The snapshot (`before`, plus child_counts where the entity has them) is taken inside the function.
 * Returns the stored deletion_requests row.
 */
export async function requestDeletionAtomic(db: Db, a: RequestDeletionArgs): Promise<Row> {
  const { actor } = a;
  const res = await db.rpc("nopm_request_deletion", {
    p_workspace_id: actor.workspaceId,
    p_entity: a.entity,
    p_target_id: a.targetId,
    p_reason: a.reason,
    p_assigned_approver_id: a.assignedApproverId,
    p_tier: a.tier,
    p_deadline: a.deadline ? a.deadline.toISOString() : null,
    p_requested_by_type: actor.type,
    p_requested_by_id: actor.id,
    p_requested_by_label: actor.label,
    p_requested_principal_id: a.requesterPrincipal,
    p_event_detail: { tier: a.tier, deadline: a.deadline?.toISOString() ?? null },
    p_audit: audit(actor, a.action, a.entity),
  });
  return unwrap<Row>(res, "nopm_request_deletion", (e) => {
    // Two concurrent requests both pass the pre-check; uniq_pending_deletion refuses the second.
    if (e.code === "23505") {
      throw new RuleError(
        `A pending deletion request already exists for this ${a.entity}`,
        "duplicate_deletion_request",
      );
    }
    invalidAssignee(e);
    if (has(e, "NOT_FOUND", "P0002")) throw new NotFoundError(`${capitalise(a.entity)} not found`);
    if (has(e, "PROJECT_LOCKED", "P0010")) throw new RuleError(PROJECT_LOCKED_MESSAGE, "project_locked");
    if (has(e, "NO_PRINCIPAL", "P0006")) throw new ScopeError(NO_MAKER_PRINCIPAL_MESSAGE, "no_principal");
    throw new Error(e.message || "Failed to create deletion request");
  });
}

/** nopm_withdraw_deletion_request. A `closedReason` records why the system closed it (target gone or locked). */
export async function withdrawDeletionAtomic(
  db: Db,
  actor: Actor,
  requestId: string,
  closedReason: "target_gone" | "project_locked" | null,
): Promise<{ id: string; status: string }> {
  const res = await db.rpc("nopm_withdraw_deletion_request", {
    p_workspace_id: actor.workspaceId,
    p_request_id: requestId,
    p_closed_reason: closedReason,
    p_audit: audit(actor, DELETION_WITHDRAWN_AUDIT_ACTION, "deletion_request"),
  });
  return unwrap(res, "nopm_withdraw_deletion_request", (e) => {
    if (has(e, "NOT_FOUND", "P0002")) throw new NotFoundError("Deletion request not found");
    if (has(e, "ALREADY_DECIDED", "P0001")) throw new RuleError("Request already decided", "already_decided");
    throw new Error(e.message || "Failed to withdraw the deletion request");
  });
}

/** nopm_reject_deletion_request: status, approver and audit row together. */
export async function rejectDeletionAtomic(
  db: Db,
  actor: Actor,
  requestId: string,
  principal: string,
  reason: string,
): Promise<{ id: string; status: string }> {
  const res = await db.rpc("nopm_reject_deletion_request", {
    p_workspace_id: actor.workspaceId,
    p_request_id: requestId,
    p_approver_type: actor.type,
    p_approver_id: actor.id,
    p_approver_label: actor.label,
    p_approver_principal_id: principal,
    p_reason: reason,
    p_audit: audit(actor, DELETION_REJECTED_AUDIT_ACTION, "deletion_request"),
  });
  return unwrap(res, "nopm_reject_deletion_request", (e) => {
    if (has(e, "NOT_FOUND", "P0002")) throw new NotFoundError("Deletion request not found");
    // The caller reloads the row and answers repeat decision or "already decided".
    if (has(e, "ALREADY_DECIDED", "P0001")) throw new AlreadyDecidedSignal();
    throw new Error(e.message || "Failed to reject the deletion request");
  });
}

/** Thrown by rejectDeletionAtomic when the request left `pending` first; decide.ts turns it into the usual answer. */
export class AlreadyDecidedSignal extends Error {
  constructor() {
    super("ALREADY_DECIDED");
    this.name = "AlreadyDecidedSignal";
  }
}

// ── change requests ────────────────────────────────────────────────────────────────────────────

export type RaiseChangeRequestArgs = {
  actor: Actor;
  /** baseFields plus reference_id, exactly what the emergency function takes, plus `status`. */
  input: Record<string, unknown>;
  tier: string;
  deadline: Date | null;
  assignedApproverId: string | null;
  requesterPrincipal: string;
  reason: string | null | undefined;
};

/**
 * nopm_raise_change_request (every tier except emergency). Returns the RAW rpc result so insertWithReference can
 * retry a reference-number clash (23505) with the next number; the route throws on any other error.
 */
export function raiseChangeRequestRpc(db: Db, a: RaiseChangeRequestArgs) {
  return db.rpc("nopm_raise_change_request", {
    p_workspace_id: a.actor.workspaceId,
    p_input: a.input,
    p_tier: a.tier,
    p_deadline: a.deadline ? a.deadline.toISOString() : null,
    p_assigned_approver_id: a.assignedApproverId,
    p_principal_id: a.requesterPrincipal,
    p_event_detail: { tier: a.tier, deadline: a.deadline?.toISOString() ?? null, reason: a.reason },
    p_audit: audit(a.actor, CHANGE_REQUEST_CREATE_AUDIT_ACTION, "change_request"),
  });
}

const NOT_REQUESTER_MESSAGE = "Only the requester can edit an open change request; raise a new one instead";

function crError(verb: "editing" | "deleting"): (e: RpcErr) => never {
  return (e) => {
    if (has(e, "NOT_FOUND", "P0002")) throw new NotFoundError("Change request not found");
    if (has(e, "CR_DECIDED", "P0001")) {
      throw new RuleError(`This change request was decided while you were ${verb} it.`, "change_request_decided");
    }
    if (has(e, "NOT_REQUESTER", "P0023")) throw new ScopeError(NOT_REQUESTER_MESSAGE, "not_requester");
    if (has(e, "NO_PRINCIPAL", "P0006")) throw new ScopeError(NO_MAKER_PRINCIPAL_MESSAGE, "no_principal");
    throw new Error(e.message || "Change request write failed");
  };
}

/** nopm_edit_change_request: update + `change_request.update` (before = locked row, after = stored row). */
export async function editChangeRequestAtomic(
  db: Db,
  actor: Actor,
  id: string,
  updates: Record<string, unknown>,
  editorPrincipal: string,
): Promise<Row> {
  const res = await db.rpc("nopm_edit_change_request", {
    p_workspace_id: actor.workspaceId,
    p_id: id,
    p_updates: updates,
    p_editor_principal: editorPrincipal,
    p_audit: audit(actor, CHANGE_REQUEST_UPDATE_AUDIT_ACTION, "change_request"),
  });
  return unwrap<Row>(res, "nopm_edit_change_request", crError("editing"));
}

/** nopm_withdraw_change_request: delete + `change_request.delete` (before = the row, after = null). */
export async function withdrawChangeRequestAtomic(
  db: Db,
  actor: Actor,
  id: string,
  editorPrincipal: string,
): Promise<Row> {
  const res = await db.rpc("nopm_withdraw_change_request", {
    p_workspace_id: actor.workspaceId,
    p_id: id,
    p_editor_principal: editorPrincipal,
    p_audit: audit(actor, CHANGE_REQUEST_DELETE_AUDIT_ACTION, "change_request"),
  });
  return unwrap<Row>(res, "nopm_withdraw_change_request", crError("deleting"));
}

// ── rebaselines ────────────────────────────────────────────────────────────────────────────────

export type ProposeRebaselineArgs = {
  actor: Actor;
  projectId: string;
  reason: string;
  tier: string;
  deadline: Date | null;
  assignedApproverId: string | null;
  requesterPrincipal: string;
  noteBefore: unknown;
  noteAfter: unknown;
};

/** nopm_propose_rebaseline: next version, exact dates, `rebaseline.create` and the deadline_set event together. */
export async function proposeRebaselineAtomic(db: Db, a: ProposeRebaselineArgs): Promise<Row> {
  const { actor } = a;
  const res = await db.rpc("nopm_propose_rebaseline", {
    p_workspace_id: actor.workspaceId,
    p_project_id: a.projectId,
    p_reason: a.reason,
    p_tier: a.tier,
    p_deadline: a.deadline ? a.deadline.toISOString() : null,
    p_assigned_approver_id: a.assignedApproverId,
    p_requested_by: actor.type === "user" ? actor.id : null,
    p_principal_id: a.requesterPrincipal,
    p_note_before: a.noteBefore ?? null,
    p_note_after: a.noteAfter ?? null,
    p_audit: audit(actor, REBASELINE_CREATE_AUDIT_ACTION, "rebaseline"),
  });
  return unwrap<Row>(res, "nopm_propose_rebaseline", (e) => {
    if (e.code === "23505") {
      // D4: uniq_pending_rebaseline allows ONE rebaseline waiting for sign-off per project. R-15: only that index
      // maps to the "already waiting" message; a (project, version) collision from two racing proposals is a
      // different conflict and must not be reported as a pending sign-off.
      const detail = `${e.message ?? ""} ${e.details ?? ""}`;
      if (detail.includes("uniq_pending_rebaseline")) {
        throw new ConflictError(PENDING_REBASELINE_EXISTS_MESSAGE, "pending_rebaseline_exists");
      }
      throw new ConflictError(
        "Another rebaseline proposal was created at the same moment. Reload and try again.",
        "rebaseline_version_conflict",
      );
    }
    invalidAssignee(e);
    if (has(e, "NOT_FOUND", "P0002")) throw new NotFoundError("Project not found");
    if (has(e, "PROJECT_NOT_LOCKED", "P0019")) throw new RuleError(LOCK_FIRST_MESSAGE, "project_not_locked");
    if (has(e, "NO_PRINCIPAL", "P0006")) throw new ScopeError(NO_MAKER_PRINCIPAL_MESSAGE, "no_principal");
    throw new Error(e.message || "Failed to create the rebaseline");
  });
}
