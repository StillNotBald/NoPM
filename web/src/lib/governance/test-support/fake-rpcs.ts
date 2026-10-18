/**
 * In-memory mirrors of the audit-writing RPCs of migrations 0062 / 0063
 * (rebaseline apply, unlock, sign-off, change-request decision, lock), for the
 * unit tests of the routes and decide.ts that call them. Test support only.
 * Same guard ORDER and errcodes as the SQL, so the TypeScript error mapping is
 * exercised against the contract the database enforces; the SQL itself is
 * covered by the migration-text tests and the local-DB probes.
 */
import type { FakeDb, Row, RpcResult } from "./fake-admin";

const CHANNELS = new Set(["ui", "api", "cli", "mcp", "assistant", "lark"]);

function rpcError(code: string, message: string): RpcResult {
  return { data: null, error: { message, code } };
}

function auditBase(args: Record<string, unknown>) {
  return {
    workspace_id: args.p_workspace_id,
    actor_type: args.p_actor_type,
    actor_id: args.p_actor_id,
    actor_label: args.p_actor_label,
    channel: (args.p_channel as string | null | undefined) ?? null,
    request_id: args.p_correlation_id ?? null,
    via_connector_id: args.p_via_connector_id ?? null,
    external_event_id: args.p_external_event_id ?? null,
    external_actor_ref: args.p_external_actor_ref ?? null,
  };
}

function pushAudit(db: FakeDb, args: Record<string, unknown>, row: Row): void {
  db.rows("audit_log").push({ ...auditBase(args), id: db.nextId("audit_log"), ...row });
}

function channelGuard(args: Record<string, unknown>): RpcResult | null {
  const channel = (args.p_channel as string | null | undefined) ?? null;
  return channel !== null && !CHANNELS.has(channel) ? rpcError("P0005", "INVALID_CHANNEL") : null;
}

/** Channel, principal and approver-role guards, in the SQL order. */
function approverGuards(db: FakeDb, args: Record<string, unknown>): RpcResult | null {
  const bad = channelGuard(args);
  if (bad) return bad;
  const principal = (args.p_approver_principal_id as string | null | undefined) ?? null;
  if (!principal) return rpcError("P0006", "NO_PRINCIPAL");
  const profile = db.rows("profiles").find((p) => p.id === principal && p.workspace_id === args.p_workspace_id);
  if (!profile || (profile.role !== "admin" && profile.role !== "manager")) {
    return rpcError("P0018", "ROLE_NOT_PERMITTED: only managers and admins can approve");
  }
  return null;
}

function withoutBaselineBefore(row: Row): Row {
  const { baseline_before: _drop, ...rest } = row;
  void _drop;
  return rest;
}

/** Mirrors nopm_apply_rebaseline (0062). */
export function applyRebaselineRpc(args: Record<string, unknown>, db: FakeDb): RpcResult {
  const guard = approverGuards(db, args);
  if (guard) return guard;
  const principal = args.p_approver_principal_id as string;
  const r = db.rows("rebaselines").find((x) => x.id === args.p_rebaseline_id && x.workspace_id === args.p_workspace_id);
  if (!r) return rpcError("P0002", "NOT_FOUND");
  if (r.requested_by && r.requested_by === args.p_actor_id) return rpcError("P0003", "SELF_APPROVAL");
  if (r.requested_principal_id && r.requested_principal_id === principal) return rpcError("P0003", "SELF_APPROVAL");
  if (r.status !== "approved") return rpcError("P0001", "ALREADY_DECIDED");
  const proj = db.rows("projects").find((p) => p.id === r.project_id && p.workspace_id === args.p_workspace_id);
  if (!proj || !proj.is_locked) return rpcError("P0019", "PROJECT_NOT_LOCKED");

  const before = { start: proj.baseline_start_date ?? null, target: proj.baseline_target_date ?? null };
  const beforeRow = { ...r };
  for (const m of db.rows("milestones")) {
    if (m.project_id === r.project_id && m.target_date != null) m.baseline_target_date = m.target_date;
  }
  for (const t of db.rows("tasks")) {
    if (t.project_id === r.project_id && (t.start_date != null || t.due_date != null)) {
      t.baseline_start_date = t.start_date ?? null;
      t.baseline_due_date = t.due_date ?? null;
    }
  }
  if (proj.start_date != null) proj.baseline_start_date = proj.start_date;
  if (proj.target_date != null) proj.baseline_target_date = proj.target_date;
  const after = { start: proj.baseline_start_date ?? null, target: proj.baseline_target_date ?? null };

  Object.assign(r, { status: "applied", applied_at: new Date().toISOString() });
  pushAudit(db, args, {
    action: "rebaseline.apply",
    target_type: "rebaseline",
    target_id: r.id,
    before: withoutBaselineBefore(beforeRow),
    after: { ...withoutBaselineBefore({ ...r }), project_baseline: { before, after } },
  });
  return { data: withoutBaselineBefore({ ...r }), error: null };
}

/** Mirrors nopm_unlock_project_audited (0062). */
export function unlockProjectAuditedRpc(args: Record<string, unknown>, db: FakeDb): RpcResult {
  const bad = channelGuard(args);
  if (bad) return bad;
  const proj = db.rows("projects").find((p) => p.id === args.p_project_id && p.workspace_id === args.p_workspace_id);
  if (!proj) return rpcError("P0002", "NOT_FOUND: project not found");
  const beforeRow = { ...proj };
  const cancelled = db
    .rows("rebaselines")
    .filter(
      (x) =>
        x.project_id === args.p_project_id &&
        x.workspace_id === args.p_workspace_id &&
        (x.status === "pending_approval" || x.status === "approved"),
    )
    .sort((a, b) => Number(a.version) - Number(b.version))
    .map((x) => {
      const previous_status = x.status;
      x.status = "cancelled";
      return { id: x.id, version: x.version, previous_status };
    });
  Object.assign(proj, { is_locked: false, locked_by: null, locked_at: null, lock_reason: null });
  pushAudit(db, args, {
    action: "project.unlock",
    target_type: "project",
    target_id: proj.id,
    before: beforeRow,
    after: { ...proj, unlock_reason: args.p_reason, cancelled_rebaselines: cancelled.map((c) => c.id) },
  });
  for (const c of cancelled) {
    pushAudit(db, args, {
      action: "rebaseline.cancelled",
      target_type: "rebaseline",
      target_id: c.id,
      before: { id: c.id, project_id: args.p_project_id, version: c.version, status: c.previous_status },
      after: {
        id: c.id,
        project_id: args.p_project_id,
        version: c.version,
        status: "cancelled",
        reason: "project_unlocked",
        unlock_reason: args.p_reason,
      },
    });
  }
  return { data: { project: { ...proj }, cancelled }, error: null };
}

/** Mirrors nopm_signoff_rebaseline (0063). */
export function signoffRebaselineRpc(args: Record<string, unknown>, db: FakeDb): RpcResult {
  const guard = approverGuards(db, args);
  if (guard) return guard;
  const principal = args.p_approver_principal_id as string;
  const r = db.rows("rebaselines").find((x) => x.id === args.p_rebaseline_id && x.workspace_id === args.p_workspace_id);
  if (!r) return rpcError("P0002", "NOT_FOUND");
  if (r.requested_by && r.requested_by === args.p_actor_id) return rpcError("P0003", "SELF_APPROVAL");
  if (r.requested_principal_id && r.requested_principal_id === principal) return rpcError("P0003", "SELF_APPROVAL");
  if (r.status !== "pending_approval") return rpcError("P0001", "ALREADY_DECIDED");

  const beforeRow = { ...r };
  const signoffs = db.rows("rebaseline_signoffs");
  const prev = signoffs.find((s) => s.rebaseline_id === r.id && s.approver_id === principal);
  const prevCopy = prev ? { ...prev } : null;
  const ts = new Date().toISOString();
  let sign: Row;
  if (prev) {
    Object.assign(prev, {
      approver_principal_id: principal,
      vote: args.p_vote,
      voted_at: ts,
      comment: args.p_comment ?? null,
    });
    sign = prev;
  } else {
    sign = {
      id: db.nextId("rebaseline_signoffs"),
      workspace_id: args.p_workspace_id,
      rebaseline_id: r.id,
      approver_id: principal,
      approver_principal_id: principal,
      vote: args.p_vote,
      voted_at: ts,
      comment: args.p_comment ?? null,
    };
    signoffs.push(sign);
  }
  const votes = signoffs.filter((s) => s.rebaseline_id === r.id);
  if (votes.some((v) => v.vote === "no_go")) r.status = "rejected";
  else if (votes.some((v) => v.vote === "go") && !votes.some((v) => v.vote === "pending")) r.status = "approved";

  pushAudit(db, args, {
    action: "rebaseline.signoff",
    target_type: "rebaseline",
    target_id: r.id,
    before: {
      ...withoutBaselineBefore(beforeRow),
      signoff: prevCopy
        ? { approver_id: principal, vote: prevCopy.vote, comment: prevCopy.comment ?? null, voted_at: prevCopy.voted_at ?? null }
        : null,
    },
    after: {
      ...withoutBaselineBefore({ ...r }),
      signoff: {
        approver_id: principal,
        vote: args.p_vote,
        comment: args.p_comment ?? null,
        voted_at: ts,
        previous_vote: prevCopy ? prevCopy.vote : null,
      },
    },
  });
  return { data: { signoff: { ...sign }, rebaseline: withoutBaselineBefore({ ...r }) }, error: null };
}

/** Mirrors nopm_decide_change_request (0063). */
export function decideChangeRequestRpc(args: Record<string, unknown>, db: FakeDb): RpcResult {
  const guard = approverGuards(db, args);
  if (guard) return guard;
  const principal = args.p_approver_principal_id as string;
  const cr = db.rows("change_requests").find((x) => x.id === args.p_id && x.workspace_id === args.p_workspace_id);
  if (!cr) return rpcError("P0002", "NOT_FOUND");
  if (cr.status !== "raised" && cr.status !== "under_review") return rpcError("P0001", "ALREADY_DECIDED");
  if (
    (cr.requested_by && cr.requested_by === args.p_actor_id) ||
    (cr.requested_by_id && cr.requested_by_id === args.p_actor_id && cr.requested_by_type === args.p_actor_type) ||
    (cr.requested_principal_id && cr.requested_principal_id === principal)
  ) {
    return rpcError("P0003", "SELF_APPROVAL");
  }
  const expected = args.p_expected_updated_at as string | null | undefined;
  if (expected && cr.updated_at !== expected && Date.parse(String(cr.updated_at)) !== Date.parse(expected)) {
    return rpcError("P0021", "PRECONDITION_FAILED");
  }
  const beforeRow = { ...cr };
  Object.assign(cr, {
    status: args.p_new_status,
    decided_by: args.p_actor_type === "user" ? args.p_actor_id : null,
    decided_by_label: args.p_actor_label,
    decided_by_type: args.p_actor_type,
    decided_by_id: args.p_actor_id,
    decided_principal_id: principal,
    decision_rationale: args.p_rationale,
    decided_at: new Date().toISOString(),
  });
  pushAudit(db, args, {
    action: "change_request.decide",
    target_type: "change_request",
    target_id: cr.id,
    before: beforeRow,
    after: { ...cr },
  });
  return { data: { ...cr }, error: null };
}

/** Mirrors nopm_lock_project (0063). */
export function lockProjectRpc(args: Record<string, unknown>, db: FakeDb): RpcResult {
  const bad = channelGuard(args);
  if (bad) return bad;
  const proj = db.rows("projects").find((p) => p.id === args.p_project_id && p.workspace_id === args.p_workspace_id);
  if (!proj) return rpcError("P0002", "NOT_FOUND: project not found");
  // 0076 (Q-GOV-9): an already locked project is returned untouched, no audit row.
  if (proj.is_locked) return { data: { ...proj, already_locked: true }, error: null };
  const beforeRow = { ...proj };
  if (!proj.is_locked) {
    for (const m of db.rows("milestones")) {
      if (m.project_id === proj.id && m.baseline_target_date == null && m.target_date != null) {
        m.baseline_target_date = m.target_date;
      }
    }
    for (const t of db.rows("tasks")) {
      if (
        t.project_id === proj.id &&
        t.baseline_start_date == null &&
        t.baseline_due_date == null &&
        (t.start_date != null || t.due_date != null)
      ) {
        t.baseline_start_date = t.start_date ?? null;
        t.baseline_due_date = t.due_date ?? null;
      }
    }
    proj.baseline_start_date = proj.baseline_start_date ?? proj.start_date ?? null;
    proj.baseline_target_date = proj.baseline_target_date ?? proj.target_date ?? null;
  }
  Object.assign(proj, {
    is_locked: true,
    locked_by: args.p_actor_type === "user" ? args.p_actor_id : null,
    locked_at: new Date().toISOString(),
    lock_reason: args.p_reason ?? null,
  });
  pushAudit(db, args, {
    action: "project.lock",
    target_type: "project",
    target_id: proj.id,
    before: beforeRow,
    after: {
      ...proj,
      project_baseline: {
        before: { start: beforeRow.baseline_start_date ?? null, target: beforeRow.baseline_target_date ?? null },
        after: { start: proj.baseline_start_date ?? null, target: proj.baseline_target_date ?? null },
      },
    },
  });
  return { data: { ...proj }, error: null };
}

/** Mirrors nopm_transition_change_request (0076). */
export function transitionChangeRequestRpc(args: Record<string, unknown>, db: FakeDb): RpcResult {
  const bad = channelGuard(args);
  if (bad) return bad;
  const principal = (args.p_principal_id as string | null | undefined) ?? null;
  if (!principal) return rpcError("P0006", "NO_PRINCIPAL");
  const profile = db.rows("profiles").find((p) => p.id === principal && p.workspace_id === args.p_workspace_id);
  const isApprover = !!profile && (profile.role === "admin" || profile.role === "manager");
  const cr = db.rows("change_requests").find((x) => x.id === args.p_id && x.workspace_id === args.p_workspace_id);
  if (!cr) return rpcError("P0002", "NOT_FOUND");
  const beforeRow = { ...cr };
  if (args.p_action === "start_review") {
    if (!isApprover) return rpcError("P0018", "ROLE_NOT_PERMITTED");
    if (cr.status !== "raised") return rpcError("P0024", "INVALID_TRANSITION");
    cr.status = "under_review";
  } else {
    if (cr.status !== "deferred") return rpcError("P0024", "INVALID_TRANSITION");
    if (!(isApprover || (cr.requested_principal_id && cr.requested_principal_id === principal) || cr.requested_by === principal)) {
      return rpcError("P0023", "NOT_REQUESTER");
    }
    Object.assign(cr, {
      status: "under_review",
      decided_by: null,
      decided_by_label: null,
      decided_by_type: null,
      decided_by_id: null,
      decided_principal_id: null,
      decision_rationale: null,
      decided_at: null,
    });
  }
  cr.updated_at = new Date().toISOString();
  pushAudit(db, args, {
    action: args.p_action === "start_review" ? "change_request.start_review" : "change_request.reopen",
    target_type: "change_request",
    target_id: cr.id,
    before: beforeRow,
    after: { ...cr },
  });
  return { data: { ...cr }, error: null };
}

/** Mirrors nopm_withdraw_rebaseline (0076). */
export function withdrawRebaselineRpc(args: Record<string, unknown>, db: FakeDb): RpcResult {
  const bad = channelGuard(args);
  if (bad) return bad;
  const principal = (args.p_principal_id as string | null | undefined) ?? null;
  if (!principal) return rpcError("P0006", "NO_PRINCIPAL");
  const r = db.rows("rebaselines").find((x) => x.id === args.p_rebaseline_id && x.workspace_id === args.p_workspace_id);
  if (!r) return rpcError("P0002", "NOT_FOUND");
  if (!((r.requested_principal_id && r.requested_principal_id === principal) || (r.requested_by && r.requested_by === args.p_actor_id))) {
    return rpcError("P0023", "NOT_REQUESTER");
  }
  if (r.status !== "pending_approval") return rpcError("P0001", "ALREADY_DECIDED");
  const beforeRow = { ...r };
  r.status = "cancelled";
  pushAudit(db, args, {
    action: "rebaseline.withdrawn",
    target_type: "rebaseline",
    target_id: r.id,
    before: withoutBaselineBefore(beforeRow),
    after: { ...withoutBaselineBefore({ ...r }), reason: "withdrawn_by_proposer" },
  });
  return { data: withoutBaselineBefore({ ...r }), error: null };
}
