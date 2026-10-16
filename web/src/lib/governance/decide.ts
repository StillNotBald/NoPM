import { requireScope, type Actor } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit/write";
import { notify, resolveWorkspaceApprovers } from "@/lib/notify/publish";
import { emitApprovalDecided, emitApprovalRequested } from "@/lib/integrations/emit";
import type {
  ApprovalDecidedEvent,
  ApprovalEvent,
  ApprovalKind,
  ApprovalRef,
} from "@/lib/integrations/types";
import {
  resolveDeletionApproveScope,
  resolveDeletionCommitRpc,
  resolveDeletionRequestScope,
} from "@/lib/governance/deletion-dispatch";
import {
  assertDecidable,
  assertNotSelfDecision,
  assertRationaleOnReject,
  assertReopenable,
  type TimesheetDecision,
} from "@/lib/governance/timesheet-decision";

/**
 * One governed decision path for every surface (UI, REST, CLI, MCP, Lark).
 *
 * The REST decision routes (deletion approve/reject/withdraw, change-request
 * decision, timesheet decision) are thin wrappers over the per-kind functions
 * below, and the Integration Hub's inbound pipeline calls `decideApproval`, so
 * a click in a chat card runs exactly the code a console click runs: same
 * scopes, same locks, same one-audit-row rule, same four-eyes.
 *
 * FOUR-EYES COMPARES HUMANS, NOT ACTOR IDS (2026-10-16, D1). `Actor.principalId`
 * is the person behind the actor: a session user is their own principal, a PAT
 * is its creator (`api_tokens.created_by`), a verified connector click is the
 * linked profile. Every decision here
 *   1. requires a principal — a token with no recorded owner can NEVER decide
 *      (fail-closed, 403 `no_principal`), and
 *   2. refuses when the decider's principal equals the stored requester
 *      principal (403 `self_approval`), on top of the legacy actor-id check
 *      that existing rows and DB constraints still rely on.
 * Migration 0045 repeats the principal rule in the database as a backstop.
 */

export type DecisionResult = {
  kind: ApprovalKind;
  id: string;
  /** The request's status after the decision (e.g. "committed", "rejected", "approved"). */
  status: string;
  /** Human-readable title of the decided request (for chat cards / toasts). */
  title: string;
  requesterPrincipalId: string | null;
};

/** What the per-kind functions return: the shared result plus the decided row (the REST routes echo it). */
export type KindOutcome = { result: DecisionResult; row: Record<string, unknown> };

type Db = ReturnType<typeof createAdminClient>;

// ── principal helpers (shared with the rebaseline routes) ─────────────────

export const NO_PRINCIPAL_MESSAGE =
  "This token has no recorded owner, so it cannot approve (four-eyes)";
export const SELF_APPROVAL_MESSAGE = "Self-approval is not allowed (four-eyes)";

/**
 * The human behind `actor`, or null when it cannot be established. A session
 * user is their own principal even if a caller built the Actor without the
 * field; a token NEVER falls back to its own id (that is the bug).
 */
export function principalOf(actor: Actor): string | null {
  if (actor.principalId) return actor.principalId;
  return actor.type === "user" ? actor.id : null;
}

/** The decider's principal, or 403 `no_principal` (fail-closed). */
export function requirePrincipal(actor: Actor): string {
  const principal = principalOf(actor);
  if (!principal) throw new ScopeError(NO_PRINCIPAL_MESSAGE, "no_principal");
  return principal;
}

/** 403 `self_approval`. */
export function selfApprovalError(message = SELF_APPROVAL_MESSAGE): ScopeError {
  return new ScopeError(message, "self_approval");
}

/**
 * Throws 403 when the decider is the same HUMAN as the stored requester.
 *
 * A missing requester principal (a legacy row raised by a token that had no
 * recorded creator) cannot be compared and PASSES — such a request stays
 * approvable by any human principal; only the actor-id check still applies. That
 * is deliberate: blocking it would strand those requests forever. (It is the
 * DECIDER side that fails closed: see requirePrincipal.)
 */
export function assertNotRequesterPrincipal(
  requesterPrincipalId: string | null | undefined,
  deciderPrincipalId: string,
  message?: string,
): void {
  if (requesterPrincipalId && requesterPrincipalId === deciderPrincipalId) {
    throw selfApprovalError(message);
  }
}

/** Legacy actor-identity compare (id AND type — the two id namespaces are disjoint). */
function isSameActor(actor: Actor, byType: string | null | undefined, byId: string | null | undefined): boolean {
  return !!byId && byId === actor.id && (byType ?? "user") === actor.type;
}

// ── event helpers ─────────────────────────────────────────────────────────

/** "Alex" for a person, "agent-name (token)" for a token. */
export function actorLabel(actor: Pick<Actor, "type" | "label">): string {
  return actor.type === "token" ? `${actor.label} (token)` : actor.label;
}

function storedLabel(label: string | null | undefined, type: string | null | undefined): string {
  const base = label ?? "unknown";
  return type === "token" ? `${base} (token)` : base;
}

function channelOf(actor: Actor): string {
  return actor.channel ?? (actor.type === "token" ? "api" : "ui");
}

/** Project name for an event. Fail-soft: an event is never worth failing a governed write. */
export async function projectNameOf(
  db: Db,
  workspaceId: string,
  projectId: string | null | undefined,
): Promise<string | null> {
  if (!projectId) return null;
  try {
    const { data } = await db
      .from("projects")
      .select("name")
      .eq("id", projectId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    return (data?.name as string | undefined) ?? null;
  } catch {
    return null;
  }
}

async function memberNameOf(db: Db, workspaceId: string, memberId: string): Promise<string | null> {
  try {
    const { data } = await db
      .from("resource_members")
      .select("name")
      .eq("id", memberId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    return (data?.name as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * The emit entry points promise never to throw, but they run AFTER the
 * governed change and its audit row are committed — so even a bug there must
 * not turn a successful write into a 500. Belt and braces.
 */
export function announceRequested(ev: ApprovalEvent): void {
  try {
    emitApprovalRequested(ev);
  } catch (err) {
    console.error("[governance] emitApprovalRequested failed", err);
  }
}

export function announceDecided(ev: ApprovalDecidedEvent): void {
  try {
    emitApprovalDecided(ev);
  } catch (err) {
    console.error("[governance] emitApprovalDecided failed", err);
  }
}

function decidedFrom(actor: Actor, base: ApprovalEvent, status: string): ApprovalDecidedEvent {
  return { ...base, status, decidedByLabel: actorLabel(actor), channel: channelOf(actor) };
}

/** Where a decision notice goes: the requester's HUMAN (a profile), never a token id. */
function noticeRecipients(principal: string | null | undefined): string[] {
  return principal ? [principal] : [];
}

// ── deletion requests (task + project) ────────────────────────────────────

type DeletionRow = {
  id: string;
  workspace_id: string;
  target_type: string;
  target_id: string;
  status: string;
  reason: string | null;
  requested_by_type: string;
  requested_by_id: string;
  requested_by_label: string;
  requested_principal_id: string | null;
  before: Record<string, unknown> | null;
};

async function loadDeletion(db: Db, actor: Actor, id: string): Promise<DeletionRow> {
  const { data, error } = await db
    .from("deletion_requests")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFoundError("Deletion request not found");
  return data as DeletionRow;
}

function deletionKind(row: DeletionRow): ApprovalKind {
  return row.target_type === "project" ? "project_deletion" : "task_deletion";
}

function deletionTitle(row: DeletionRow): string {
  const name = row.before && typeof row.before.name === "string" ? row.before.name : row.target_id;
  return `Delete ${row.target_type} "${name}"`;
}

async function deletionBaseEvent(db: Db, actor: Actor, row: DeletionRow): Promise<ApprovalEvent> {
  const isProject = row.target_type === "project";
  const projectId = isProject
    ? row.target_id
    : ((row.before?.project_id as string | undefined) ?? null);
  const projectName = isProject
    ? ((row.before?.name as string | undefined) ?? null)
    : await projectNameOf(db, actor.workspaceId, projectId);
  return {
    workspaceId: actor.workspaceId,
    kind: deletionKind(row),
    id: row.id,
    title: deletionTitle(row),
    summary: row.reason,
    projectId,
    projectName,
    requestedByLabel: storedLabel(row.requested_by_label, row.requested_by_type),
    requesterPrincipalId: row.requested_principal_id,
  };
}

function expectTarget(row: DeletionRow, want: "task" | "project" | undefined): void {
  if (want && row.target_type !== want) throw new NotFoundError("Deletion request not found");
}

/**
 * Four-eyes checker step: approve and immediately commit the deletion. Scope is
 * per target type (task:delete:approve / project:delete:approve). The delete +
 * request commit + BOTH audit rows run in ONE Postgres transaction inside the
 * commit RPC, which re-validates pending / four-eyes / principal under its own
 * row lock — the checks here give a precise error and an early exit, the RPC
 * is the source of truth.
 */
export async function approveDeletion(
  actor: Actor,
  id: string,
  opts: { note?: string | null; expectTarget?: "task" | "project" } = {},
): Promise<KindOutcome> {
  const db = createAdminClient();
  const row = await loadDeletion(db, actor, id);
  expectTarget(row, opts.expectTarget);

  requireScope(actor, resolveDeletionApproveScope(row.target_type));
  const principal = requirePrincipal(actor);

  if (row.status !== "pending") throw new RuleError("Request already decided", "already_decided");
  if (isSameActor(actor, row.requested_by_type, row.requested_by_id)) throw selfApprovalError();
  assertNotRequesterPrincipal(row.requested_principal_id, principal);

  const note = opts.note?.trim() ? opts.note.trim() : null;
  const { error } = await db.rpc(resolveDeletionCommitRpc(row.target_type), {
    p_request_id: id,
    p_workspace_id: actor.workspaceId,
    p_approver_type: actor.type,
    p_approver_id: actor.id,
    p_approver_label: actor.label,
    p_approver_principal_id: principal,
    // R-84: provenance on the RPC-written audit rows. Named p_correlation_id
    // on the RPC side (migration 0044) — NOT p_request_id — because that name
    // is already the deletion_requests row id above.
    p_channel: actor.channel ?? null,
    p_correlation_id: actor.requestId ?? null,
    // UC-12: the approver's optional note is recorded in the audit row.
    p_note: note,
    // Connector provenance (a chat-card approval): written on every audit row
    // the RPC inserts, same as writeAudit does for the non-RPC verbs. Null for
    // the console, CLI, MCP and REST.
    p_via_connector_id: actor.viaConnectorId ?? null,
    p_external_event_id: actor.externalEventId ?? null,
    p_external_actor_ref: actor.externalActorRef ?? null,
  });

  if (error) {
    const m = `${error.message ?? ""} ${error.code ?? ""}`;
    if (m.includes("NOT_FOUND") || error.code === "P0002") throw new NotFoundError("Deletion request not found");
    if (m.includes("ALREADY_DECIDED") || error.code === "P0001") throw new RuleError("Request already decided", "already_decided");
    if (m.includes("SELF_APPROVAL") || error.code === "P0003") throw selfApprovalError();
    if (m.includes("NO_PRINCIPAL") || error.code === "P0006") throw new ScopeError(NO_PRINCIPAL_MESSAGE, "no_principal");
    if (m.includes("PROJECT_LOCKED") || error.code === "P0010")
      throw new RuleError("Project is locked — unlock or rebaseline before committing this deletion.", "project_locked");
    throw new Error(error.message || "Failed to commit deletion");
  }

  // Notify the original requester (their human, not a token id) — fail-soft
  // (outside the transaction by design).
  void notify({
    workspaceId: actor.workspaceId,
    recipientIds: noticeRecipients(row.requested_principal_id),
    type: "approval.approved",
    title: "Your deletion request was approved",
    body: `The deletion of ${row.target_type} has been approved and committed.`,
    payload: { requestId: row.id, targetType: row.target_type, targetId: row.target_id },
  });

  const base = await deletionBaseEvent(db, actor, row);
  announceDecided(decidedFrom(actor, base, "committed"));

  return {
    result: {
      kind: base.kind,
      id: row.id,
      status: "committed",
      title: base.title,
      requesterPrincipalId: row.requested_principal_id,
    },
    row: { ...row, status: "committed" },
  };
}

/**
 * Checker step: reject a pending deletion request. Same per-type scope gate and
 * the same four-eyes rule as approve — a self-decision is refused, and it is
 * guarded here (not left to the DB CHECK) so the caller gets a clean error.
 */
export async function rejectDeletion(
  actor: Actor,
  id: string,
  opts: { reason?: string | null; expectTarget?: "task" | "project" } = {},
): Promise<KindOutcome> {
  const db = createAdminClient();
  const row = await loadDeletion(db, actor, id);
  expectTarget(row, opts.expectTarget);

  // Per-type checker gate (mirrors approve — guard symmetry on every decision verb)
  requireScope(actor, resolveDeletionApproveScope(row.target_type));
  const principal = requirePrincipal(actor);

  if (row.status !== "pending") throw new RuleError("Request already decided", "already_decided");

  // Legacy same-actor check keeps its historical 422; the principal rule is 403.
  if (isSameActor(actor, row.requested_by_type, row.requested_by_id)) {
    throw new RuleError(
      "A different person must decide this request — self-rejection is blocked (four-eyes)",
      "self_approval",
    );
  }
  assertNotRequesterPrincipal(
    row.requested_principal_id,
    principal,
    "A different person must decide this request — self-rejection is blocked (four-eyes)",
  );

  const reason = opts.reason?.trim() ? opts.reason.trim() : null;
  const now = new Date().toISOString();

  // Compare-and-set on status: two checkers racing can't both "reject".
  const { data: updated, error: updateError } = await db
    .from("deletion_requests")
    .update({
      status: "rejected",
      approved_by_type: actor.type,
      approved_by_id: actor.id,
      approved_by_label: actor.label,
      approved_principal_id: principal,
      decided_at: now,
    })
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (updateError) throw new Error(updateError.message);
  if (!updated) throw new RuleError("Request already decided", "already_decided");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "deletion_request.rejected",
    targetType: "deletion_request",
    targetId: row.id,
    before: { status: "pending" },
    after: {
      status: "rejected",
      approver_principal_id: principal,
      ...(reason ? { reason } : {}),
    },
  });

  void notify({
    workspaceId: actor.workspaceId,
    recipientIds: noticeRecipients(row.requested_principal_id),
    type: "approval.rejected",
    title: "Your deletion request was rejected",
    body: reason ?? `The deletion of ${row.target_type} was not approved.`,
    payload: { requestId: row.id, targetType: row.target_type, targetId: row.target_id },
  });

  const base = await deletionBaseEvent(db, actor, row);
  announceDecided(decidedFrom(actor, base, "rejected"));

  return {
    result: {
      kind: base.kind,
      id: row.id,
      status: "rejected",
      title: base.title,
      requesterPrincipalId: row.requested_principal_id,
    },
    row: { ...row, status: "rejected" },
  };
}

/**
 * Maker step: withdraw your OWN still-pending deletion request. The one
 * self-decision four-eyes permits — it cancels the request rather than
 * deciding it, so no approver is recorded and no principal is needed.
 */
export async function withdrawDeletion(actor: Actor, id: string): Promise<KindOutcome> {
  const db = createAdminClient();
  const row = await loadDeletion(db, actor, id);

  // Per-type maker gate — withdrawing a project request needs project:delete:request
  requireScope(actor, resolveDeletionRequestScope(row.target_type));

  if (!isSameActor(actor, row.requested_by_type, row.requested_by_id)) {
    throw new ScopeError("Only the original requester can withdraw a deletion request");
  }
  if (row.status !== "pending") throw new RuleError("Request already decided", "already_decided");

  const { data: updated, error: updateError } = await db
    .from("deletion_requests")
    .update({ status: "withdrawn", decided_at: new Date().toISOString() })
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (updateError) throw new Error(updateError.message);
  if (!updated) throw new RuleError("Request already decided", "already_decided");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "deletion_request.withdrawn",
    targetType: "deletion_request",
    targetId: row.id,
    before: { status: "pending" },
    after: { status: "withdrawn" },
  });

  const base = await deletionBaseEvent(db, actor, row);
  announceDecided(decidedFrom(actor, base, "withdrawn"));

  return {
    result: {
      kind: base.kind,
      id: row.id,
      status: "withdrawn",
      title: base.title,
      requesterPrincipalId: row.requested_principal_id,
    },
    row: { ...row, status: "withdrawn" },
  };
}

// ── change requests ───────────────────────────────────────────────────────

export type ChangeDecision = "approve" | "reject" | "defer";

const CHANGE_STATUS: Readonly<Record<ChangeDecision, string>> = {
  approve: "approved",
  reject: "rejected",
  defer: "deferred",
};

/** The only statuses a change request can be decided from. */
const CHANGE_DECIDABLE = ["raised", "under_review"] as const;

type ChangeRow = {
  id: string;
  reference_id: string | null;
  title: string;
  description: string | null;
  impact_summary: string | null;
  project_id: string | null;
  status: string;
  requested_by: string | null;
  requested_by_type: string | null;
  requested_by_id: string | null;
  requested_by_label: string | null;
  requested_principal_id: string | null;
};

function changeTitle(cr: ChangeRow): string {
  return `Change request ${cr.reference_id ?? cr.id}: ${cr.title}`;
}

/**
 * Four-eyes: record an approve / reject / defer decision on a change request.
 * Guards: scope change:decide; the decider must have a principal; the request
 * must still be raised|under_review (checked, then enforced again as a
 * compare-and-set on the UPDATE so two deciders can't both win); and the
 * decider must be a different HUMAN from the requester (legacy profile-id and
 * actor-typed checks retained).
 */
export async function decideChangeRequest(
  actor: Actor,
  id: string,
  input: { decision: ChangeDecision; rationale: string },
): Promise<KindOutcome> {
  requireScope(actor, "change:decide");
  const db = createAdminClient();

  const { data, error: fetchError } = await db
    .from("change_requests")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (!data) throw new NotFoundError("Change request not found");
  const cr = data as ChangeRow;

  const principal = requirePrincipal(actor);

  if (!(CHANGE_DECIDABLE as readonly string[]).includes(cr.status)) {
    throw new RuleError(`Change request already decided (status: ${cr.status})`, "already_decided");
  }

  // Four-eyes. The legacy profile-id column is only ever set for user actors;
  // the actor-typed pair covers tokens/assistants; the principal covers the
  // HUMAN behind either (the case the first two cannot see).
  if (cr.requested_by && actor.id === cr.requested_by) throw selfApprovalError();
  if (isSameActor(actor, cr.requested_by_type, cr.requested_by_id)) throw selfApprovalError();
  assertNotRequesterPrincipal(cr.requested_principal_id, principal);

  const newStatus = CHANGE_STATUS[input.decision];
  const now = new Date().toISOString();

  const { data: updated, error: updateError } = await db
    .from("change_requests")
    .update({
      status: newStatus,
      decided_by: actor.type === "user" ? actor.id : null,
      decided_by_label: actor.label,
      decided_by_type: actor.type,
      decided_by_id: actor.id,
      decided_principal_id: principal,
      decision_rationale: input.rationale,
      decided_at: now,
    })
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId)
    .in("status", [...CHANGE_DECIDABLE])
    .select()
    .maybeSingle();

  if (updateError) throw new Error(updateError.message);
  if (!updated) {
    // Lost the race: someone decided between our read and our write.
    throw new RuleError("Change request already decided", "already_decided");
  }

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "change_request.decide",
    targetType: "change_request",
    targetId: updated.id,
    before: cr,
    after: updated,
  });

  void notify({
    workspaceId: actor.workspaceId,
    recipientIds: noticeRecipients(cr.requested_principal_id ?? cr.requested_by),
    type: "approval.approved",
    title: `Change request ${cr.reference_id ?? cr.id} was ${newStatus}`,
    body: input.rationale,
    payload: { changeRequestId: cr.id, decision: input.decision, status: newStatus },
  });

  const base = await changeBaseEvent(db, actor, cr);
  announceDecided(decidedFrom(actor, base, newStatus));

  return {
    result: {
      kind: "change_request",
      id: cr.id,
      status: newStatus,
      title: base.title,
      requesterPrincipalId: cr.requested_principal_id,
    },
    row: updated as Record<string, unknown>,
  };
}

async function changeBaseEvent(db: Db, actor: Actor, cr: ChangeRow): Promise<ApprovalEvent> {
  return {
    workspaceId: actor.workspaceId,
    kind: "change_request",
    id: cr.id,
    title: changeTitle(cr),
    summary: cr.impact_summary ?? cr.description,
    projectId: cr.project_id,
    projectName: await projectNameOf(db, actor.workspaceId, cr.project_id),
    requestedByLabel: storedLabel(cr.requested_by_label, cr.requested_by_type),
    requesterPrincipalId: cr.requested_principal_id,
  };
}

// ── timesheet submissions ─────────────────────────────────────────────────

type TimesheetRow = {
  id: string;
  member_id: string;
  period_start: string;
  period_end: string;
  hours_total: number | string;
  entry_count: number;
  status: string;
  submitted_by: string;
  submitted_by_type: "user" | "token";
  submitted_by_label: string;
  submitted_principal_id: string | null;
};

/** Event for a timesheet submission (also used when one is first submitted). */
export async function timesheetEvent(
  db: Db,
  workspaceId: string,
  row: TimesheetRow,
  knownMemberName?: string | null,
): Promise<ApprovalEvent> {
  const member = knownMemberName ?? (await memberNameOf(db, workspaceId, row.member_id));
  const hours = Number(row.hours_total);
  return {
    workspaceId,
    kind: "timesheet",
    id: row.id,
    title: `Timesheet: ${member ?? "member"}, week of ${row.period_start}`,
    summary: `${Number.isFinite(hours) ? hours : 0} hours across ${row.entry_count} entr${row.entry_count === 1 ? "y" : "ies"}.`,
    projectId: null,
    projectName: null,
    requestedByLabel: storedLabel(row.submitted_by_label, row.submitted_by_type),
    requesterPrincipalId: row.submitted_principal_id,
  };
}

/**
 * Four-eyes (L-31): approve / reject / reopen a timesheet submission. "reopened"
 * (R-76/L-32) is the governed unlock verb for the period-close lock and carries
 * the same guards as the other two: a principal, a different HUMAN from the
 * submitter, a rationale. Status transitions are compare-and-set.
 */
export async function decideTimesheet(
  actor: Actor,
  id: string,
  input: { decision: TimesheetDecision; rationale?: string | null },
): Promise<KindOutcome> {
  requireScope(actor, "time:approve");
  const db = createAdminClient();

  const { data, error: fetchError } = await db
    .from("timesheet_submissions")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (!data) throw new NotFoundError("Timesheet submission not found");
  const submission = data as TimesheetRow;

  const principal = requirePrincipal(actor);
  const { decision } = input;
  const rationale = input.rationale ?? undefined;

  if (decision === "reopened") {
    assertReopenable(submission.status);
  } else {
    assertDecidable(submission.status);
  }
  // Guard symmetry (R-76): the self-decision guards run before ALL THREE verbs.
  // The legacy compound (id AND type) guard throws a bare ScopeError; re-throw
  // it with the same `self_approval` code the principal guard uses so every
  // surface can tell a four-eyes refusal from a missing scope.
  try {
    assertNotSelfDecision(submission, actor);
  } catch (err) {
    if (err instanceof ScopeError) throw selfApprovalError();
    throw err;
  }
  assertNotRequesterPrincipal(submission.submitted_principal_id, principal);
  assertRationaleOnReject(decision, rationale);

  const now = new Date().toISOString();
  const expectedStatus = decision === "reopened" ? "approved" : "submitted";

  const { data: updated, error: updateError } = await db
    .from("timesheet_submissions")
    .update(
      decision === "reopened"
        ? {
            status: "submitted",
            decided_by: null,
            decided_by_type: null,
            decided_by_label: null,
            decided_principal_id: null,
            decided_at: null,
            decision_rationale: null,
          }
        : {
            status: decision,
            decided_by: actor.id,
            decided_by_type: actor.type,
            decided_by_label: actor.label,
            decided_principal_id: principal,
            decided_at: now,
            decision_rationale: rationale ?? null,
          },
    )
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId)
    .eq("status", expectedStatus)
    .select()
    .maybeSingle();

  if (updateError) throw new Error(updateError.message);
  if (!updated) throw new RuleError("Timesheet submission already decided", "already_decided");

  // Single governance row per decision — domain rows were written at submit
  // time (time.create on each entry); this is the governance step itself.
  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action:
      decision === "approved"
        ? "timesheet.approved"
        : decision === "rejected"
          ? "timesheet.rejected"
          : "timesheet.reopened",
    targetType: "timesheet_submission",
    targetId: updated.id,
    before: { status: submission.status },
    after:
      decision === "reopened"
        ? { status: updated.status, rationale }
        : {
            status: updated.status,
            decision_rationale: updated.decision_rationale,
            approver_principal_id: principal,
          },
  });

  if (decision === "reopened") {
    // The sheet re-enters the Review Queue as a fresh 'submitted' row — a new
    // approval request, so it fans out to the workspace's approvers.
    void resolveWorkspaceApprovers(actor.workspaceId).then((approverIds) =>
      notify({
        workspaceId: actor.workspaceId,
        recipientIds: approverIds,
        type: "approval.requested",
        title: `Timesheet reopened for re-review (week of ${submission.period_start})`,
        body: `Reopened by ${actor.label}: ${rationale}`,
        payload: { timesheetSubmissionId: updated.id, decision },
      }),
    );
  } else {
    void notify({
      workspaceId: actor.workspaceId,
      recipientIds: noticeRecipients(
        submission.submitted_principal_id ??
          (submission.submitted_by_type === "user" ? submission.submitted_by : null),
      ),
      type: decision === "approved" ? "approval.approved" : "approval.rejected",
      title: `Your timesheet (week of ${submission.period_start}) was ${decision}`,
      body: rationale ?? undefined,
      payload: { timesheetSubmissionId: updated.id, decision },
    });
  }

  const base = await timesheetEvent(db, actor.workspaceId, submission);
  announceDecided(decidedFrom(actor, base, decision));

  return {
    result: {
      kind: "timesheet",
      id: submission.id,
      status: decision === "reopened" ? "submitted" : decision,
      title: base.title,
      requesterPrincipalId: submission.submitted_principal_id,
    },
    row: updated as Record<string, unknown>,
  };
}

// ── the single entry point (hub inbound, any future surface) ──────────────

const DEFAULT_CHANGE_APPROVE_RATIONALE = (channel: string) => `Approved via ${channel}`;

/**
 * Approve or reject a governed request as `actor`. Throws the same ApiErrors
 * the REST routes throw (ScopeError on self-approval / missing principal /
 * missing scope, RuleError when already decided or locked, NotFoundError).
 * `note` is required (non-empty) for "reject". For "approve" it is optional:
 * deletions record it in the audit row (default none), timesheets store it as
 * the rationale (default none), and change requests — whose rationale is
 * mandatory — default to "Approved via <channel>".
 *
 * Error `code`s a caller can branch on: `self_approval`, `no_principal`,
 * `already_decided`, `rationale_required`, `forbidden_scope`.
 */
export async function decideApproval(
  actor: Actor,
  ref: ApprovalRef,
  action: "approve" | "reject",
  note?: string,
): Promise<DecisionResult> {
  const text = note?.trim() ? note.trim() : undefined;
  if (action === "reject" && !text) {
    throw new RuleError("A reason is required when rejecting", "rationale_required");
  }

  switch (ref.kind) {
    case "task_deletion":
    case "project_deletion": {
      const target = ref.kind === "project_deletion" ? "project" : "task";
      const out =
        action === "approve"
          ? await approveDeletion(actor, ref.id, { note: text, expectTarget: target })
          : await rejectDeletion(actor, ref.id, { reason: text, expectTarget: target });
      return out.result;
    }
    case "change_request": {
      const out = await decideChangeRequest(actor, ref.id, {
        decision: action,
        rationale: text ?? DEFAULT_CHANGE_APPROVE_RATIONALE(channelOf(actor)),
      });
      return out.result;
    }
    case "timesheet": {
      const out = await decideTimesheet(actor, ref.id, {
        decision: action === "approve" ? "approved" : "rejected",
        rationale: text,
      });
      return out.result;
    }
    default:
      throw new RuleError(`Unsupported approval kind: ${String((ref as { kind: unknown }).kind)}`, "unsupported_kind");
  }
}
