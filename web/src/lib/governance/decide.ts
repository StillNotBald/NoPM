import { requireScope, type Actor } from "@/lib/auth/guard";
import { APPROVER_ROLE_MESSAGE, requireApprover } from "@/lib/auth/approver";
import { checkOptimisticConcurrency } from "@/lib/api/occ";
import { createAdminClient } from "@/lib/supabase/admin";
import { NotFoundError, PreconditionFailedError, RuleError, ScopeError } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit/write";
import { removeStoredFiles } from "@/lib/governance/project-files";
import { notify, resolveWorkspaceApprovers } from "@/lib/notify/publish";
import { emitApprovalChanged, emitApprovalDecided, emitApprovalRequested } from "@/lib/integrations/emit";
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

/**
 * One governed decision path for every surface (UI, REST, CLI, MCP, Lark).
 *
 * The REST decision routes (deletion approve/reject/withdraw, change-request
 * decision) are thin wrappers over the per-kind functions
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

export const CHILDREN_CHANGED_MESSAGE =
  "This project gained records (tasks, milestones, risks, ...) after the deletion was requested, so the request no longer describes what would be deleted — reject or withdraw it and raise a new request.";
export const TARGET_CHANGED_MESSAGE =
  "This task was edited after the deletion was requested, so the request no longer describes what would be deleted — reject or withdraw it and raise a new request.";
export const TARGET_GONE_MESSAGE = "This record was already deleted, so the request is closed.";
/** Q-GOV-20: the project was locked after the deletion was requested; the request is closed, not left to fail. */
export const PROJECT_LOCKED_CLOSED_MESSAGE =
  "Closed: the project was locked after this was requested. Raise it again if still needed.";
/** Decision 20: a project that carries approved change requests or approved / applied rebaselines is not deleted. */
export const PROJECT_HAS_APPROVED_RECORDS_MESSAGE =
  "This project has approved change requests or approved rebaselines, so it cannot be deleted. They are the record of what was agreed.";
/** Q-GOV-21: a rejection always says why, on every route. */
export const REJECT_REASON_REQUIRED_MESSAGE = "Please give a reason for rejecting.";
/** Q-GOV-13: approve / reject name the version they read. */
export const VERSION_REQUIRED_MESSAGE =
  "Approve and reject must name the version you read (expected_updated_at). Reopen the request and decide again.";
/** Q-GOV-13: the request moved on since the decider read it. */
export const CHANGE_STALE_MESSAGE =
  "This request changed after you opened it. Reopen it and review the new version.";
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

export const NO_MAKER_PRINCIPAL_MESSAGE =
  "This token has no recorded owner, so it cannot raise a governed request (four-eyes needs a human on both sides)";

/**
 * The MAKER side of the same rule (red-team R1/H3). `requirePrincipal` makes the
 * decider fail closed; this makes the requester fail closed. Without it a token
 * with no recorded owner could raise a request whose requester principal is
 * null — and a null requester is, by design, comparable to nobody
 * (assertNotRequesterPrincipal passes) — so the same person could then approve
 * their own request from a normal session. Every route that RAISES a governed
 * request (task / project deletion, change request,
 * rebaseline proposal) calls this before touching anything.
 */
export function requireMakerPrincipal(actor: Actor): string {
  const principal = principalOf(actor);
  if (!principal) throw new ScopeError(NO_MAKER_PRINCIPAL_MESSAGE, "no_principal");
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

/**
 * Tell the integration hub that a PENDING request's content changed after its
 * approval card went out (a requester editing a change request): the old card
 * must stop being actionable and approvers get a fresh one with the current
 * content. Same never-throws contract as the other two announcers.
 */
export function announceChanged(ev: ApprovalEvent): void {
  try {
    emitApprovalChanged(ev);
  } catch (err) {
    console.error("[governance] emitApprovalChanged failed", err);
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
  approved_by_label?: string | null;
  approved_principal_id?: string | null;
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
 * Binds a task-deletion approval to the task AS REQUESTED (CR-gov P2-15). The
 * request's `before` is the task row at request time, including `updated_at`
 * (the table's trigger bumps it on every edit). If the live task has moved
 * since, the approver is no longer looking at what would be deleted: refuse
 * (422 `target_changed`), like `children_changed` does for projects. A legacy
 * request with no recorded version cannot be compared and passes; a task that
 * is already gone is left to the commit RPC to report.
 *
 * The commit happens inside the RPC, so an edit landing between this check and
 * the RPC is not caught here (the window is one round trip; closing it needs a
 * version argument on the RPC).
 */
async function assertTaskUnchangedSinceRequest(db: Db, workspaceId: string, row: DeletionRow): Promise<void> {
  // Q-WRK-27 (migration 0080): content_updated_at moves only when the name, dates or
  // assignee change, so a status drag does not void the request. Both sides must
  // carry it; otherwise fall back to updated_at (a request raised before 0080).
  const requestedContent = row.before?.content_updated_at;
  const useContent = typeof requestedContent === "string" && !!requestedContent;
  const requested = useContent ? requestedContent : row.before?.updated_at;
  if (typeof requested !== "string" || !requested) return;
  const { data, error } = await db
    .from("tasks")
    .select("updated_at, content_updated_at")
    .eq("id", row.target_id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const liveRow = data as { updated_at?: string | null; content_updated_at?: string | null } | null;
  let compareRequested: string = requested;
  let live = useContent ? liveRow?.content_updated_at : liveRow?.updated_at;
  if (useContent && !live) {
    // Live row has no content version: fall back to the updated_at pair.
    const fallback = row.before?.updated_at;
    if (typeof fallback !== "string" || !fallback) return;
    compareRequested = fallback;
    live = liveRow?.updated_at;
  }
  if (!live) return;
  if (live !== compareRequested && Date.parse(live) !== Date.parse(compareRequested)) {
    throw new RuleError(TARGET_CHANGED_MESSAGE, "target_changed");
  }
}

/**
 * The commit RPC found nothing to delete (P0017 TARGET_GONE, migration 0056):
 * the task or project was already removed, e.g. by a cascade. The RPC raised, so
 * nothing was committed or audited as a deletion; this closes the request so it
 * does not sit pending forever. 'withdrawn' is the closed-without-a-decision
 * status (no approver is recorded), compare-and-set on 'pending'. The audit row is
 * fail-closed (A3-5): if it cannot be written the close is undone and the failure surfaces.
 */
async function closeDeletionRequest(
  db: Db,
  actor: Actor,
  row: DeletionRow,
  reason: "target_gone" | "project_locked",
): Promise<void> {
  const { data: updated, error: closeError } = await db
    .from("deletion_requests")
    .update({ status: "withdrawn", decided_at: new Date().toISOString(), closed_reason: reason })
    .eq("id", row.id)
    .eq("workspace_id", actor.workspaceId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  // A failed close changed nothing and audited nothing: the 422 the caller is
  // about to throw stands, and the next approve attempt retries the tidy-up.
  if (closeError || !updated) return;
  try {
    await writeAudit({
      workspaceId: actor.workspaceId,
      actor,
      action: "deletion_request.withdrawn",
      targetType: "deletion_request",
      targetId: row.id,
      before: { status: "pending" },
      after: { status: "withdrawn", reason },
    });
  } catch (err) {
    // Fail closed (A3-5): a close that cannot be audited must not stand. Put the
    // request back to pending so the next attempt closes AND audits it, then
    // surface the audit failure instead of swallowing it.
    await db
      .from("deletion_requests")
      .update({ status: "pending", decided_at: null, closed_reason: null })
      .eq("id", row.id)
      .eq("workspace_id", actor.workspaceId)
      .eq("status", "withdrawn");
    throw err;
  }
  const base = await deletionBaseEvent(db, actor, row);
  announceDecided(decidedFrom(actor, base, "withdrawn"));
}

/** What a decided deletion request reads as to a person ("approved", not the stored "committed"). */
const DELETION_DONE: Readonly<Record<string, string>> = {
  committed: "approved",
  rejected: "rejected",
  withdrawn: "withdrawn",
};

/** 422 `already_decided`, naming who decided when that is known (Q-GOV-24: a different person sees who). */
function alreadyDecidedDeletion(row: DeletionRow): RuleError {
  if (row.status === "pending") return new RuleError("Request already decided", "already_decided");
  const verb = DELETION_DONE[row.status] ?? row.status;
  const by = row.approved_by_label && row.status !== "withdrawn" ? ` by ${row.approved_by_label}` : "";
  return new RuleError(`Already ${verb}${by}.`, "already_decided");
}

/**
 * Q-GOV-24: the same person repeating the SAME decision (a double tap, a retry
 * after a dropped response) is answered "done" - no second audit row, no second
 * notice. Only the human who decided counts; anyone else is told who did.
 */
function isRepeatDecision(row: DeletionRow, principal: string, want: "committed" | "rejected"): boolean {
  return row.status === want && !!row.approved_principal_id && row.approved_principal_id === principal;
}

function repeatDeletionOutcome(row: DeletionRow): KindOutcome {
  return {
    result: {
      kind: deletionKind(row),
      id: row.id,
      status: row.status,
      title: deletionTitle(row),
      requesterPrincipalId: row.requested_principal_id,
    },
    row,
  };
}

/**
 * A status flip whose audit row cannot be written must not stand (A3-5): the
 * caller puts the request back to pending here (clearing what the flip set) and
 * rethrows the audit failure, so a decision never exists without its trail.
 */
async function revertDeletionDecision(
  db: Db,
  actor: Actor,
  id: string,
  fromStatus: "rejected" | "withdrawn",
): Promise<void> {
  await db
    .from("deletion_requests")
    .update({
      status: "pending",
      decided_at: null,
      approved_by_type: null,
      approved_by_id: null,
      approved_by_label: null,
      approved_principal_id: null,
    })
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId)
    .eq("status", fromStatus);
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
  requireApprover(actor); // D-16: admins and managers only, on every channel

  if (row.status !== "pending") {
    if (isRepeatDecision(row, principal, "committed")) return repeatDeletionOutcome(row);
    throw alreadyDecidedDeletion(row);
  }
  if (isSameActor(actor, row.requested_by_type, row.requested_by_id)) throw selfApprovalError();
  assertNotRequesterPrincipal(row.requested_principal_id, principal);
  if (row.target_type === "task") await assertTaskUnchangedSinceRequest(db, actor.workspaceId, row);

  const note = opts.note?.trim() ? opts.note.trim() : null;
  const { data: committedData, error } = await db.rpc(resolveDeletionCommitRpc(row.target_type), {
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
    if (m.includes("ALREADY_DECIDED") || error.code === "P0001") {
      // Two taps racing: the RPC saw the other one's commit. Same person, same decision = done.
      const fresh = await loadDeletion(db, actor, id);
      if (isRepeatDecision(fresh, principal, "committed")) return repeatDeletionOutcome(fresh);
      throw alreadyDecidedDeletion(fresh);
    }
    if (m.includes("SELF_APPROVAL") || error.code === "P0003") throw selfApprovalError();
    if (m.includes("NO_PRINCIPAL") || error.code === "P0006") throw new ScopeError(NO_PRINCIPAL_MESSAGE, "no_principal");
    if (m.includes("ROLE_NOT_PERMITTED") || error.code === "P0018") throw new ScopeError(APPROVER_ROLE_MESSAGE, "role_not_permitted");
    // Q-GOV-20: the project was locked after the request was raised. The commit
    // rolled back; the request can never succeed as written, so it is closed
    // (audited) rather than left to fail on every attempt.
    if (m.includes("PROJECT_LOCKED") || error.code === "P0010") {
      await closeDeletionRequest(db, actor, row, "project_locked");
      throw new RuleError(PROJECT_LOCKED_CLOSED_MESSAGE, "project_locked");
    }
    // Decision 20 (0076): approved change requests / approved or applied rebaselines
    // are the record of what was agreed; the project is not deleted over them.
    if (m.includes("PROJECT_HAS_APPROVED_RECORDS") || error.code === "P0022")
      throw new RuleError(PROJECT_HAS_APPROVED_RECORDS_MESSAGE, "project_has_approved_records");
    // 0056: the target was already gone, the RPC rolled back (no commit, no
    // task.delete / project.delete audit row). Close the stale request.
    if (m.includes("TARGET_GONE") || error.code === "P0017") {
      await closeDeletionRequest(db, actor, row, "target_gone");
      throw new RuleError(TARGET_GONE_MESSAGE, "target_gone");
    }
    // R1/M4: the project gained children after the request was raised (migration
    // 0049 trigger on projects). The approver must see the CURRENT scope, so the
    // request is refused; withdraw it and raise a new one.
    if (m.includes("CHILDREN_CHANGED") || error.code === "P0016")
      throw new RuleError(CHILDREN_CHANGED_MESSAGE, "children_changed");
    throw new Error(error.message || "Failed to commit deletion");
  }

  // Decision 20: the project is gone, so its documents' stored files go too.
  // After the commit, fail-soft (the cascade audit rows carry every path, so a
  // leftover object can be traced and removed by hand).
  if (row.target_type === "project") {
    await removeStoredFiles((committedData as { document_paths?: unknown } | null)?.document_paths, actor.workspaceId);
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
  requireApprover(actor); // D-16

  if (row.status !== "pending") {
    if (isRepeatDecision(row, principal, "rejected")) return repeatDeletionOutcome(row);
    throw alreadyDecidedDeletion(row);
  }

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

  // Q-GOV-21: a rejection always says why, on every route.
  const reason = opts.reason?.trim() ? opts.reason.trim() : null;
  if (!reason) throw new RuleError(REJECT_REASON_REQUIRED_MESSAGE, "rationale_required");

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
  if (!updated) {
    const fresh = await loadDeletion(db, actor, id);
    if (isRepeatDecision(fresh, principal, "rejected")) return repeatDeletionOutcome(fresh);
    throw alreadyDecidedDeletion(fresh);
  }

  try {
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
        reason,
      },
    });
  } catch (err) {
    await revertDeletionDecision(db, actor, row.id, "rejected");
    throw err;
  }

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
 *
 * "Your own" is the same actor OR the same human: a request raised by a person's
 * token or assistant (whose ephemeral token is gone by the time they look) can
 * be withdrawn by the person behind it. Withdrawing decides nothing, so the
 * four-eyes rule that bars that person from DECIDING does not apply.
 */
export async function withdrawDeletion(actor: Actor, id: string): Promise<KindOutcome> {
  const db = createAdminClient();
  const row = await loadDeletion(db, actor, id);

  // Per-type maker gate — withdrawing a project request needs project:delete:request
  requireScope(actor, resolveDeletionRequestScope(row.target_type));

  const principal = principalOf(actor);
  const isRequester =
    isSameActor(actor, row.requested_by_type, row.requested_by_id) ||
    (!!principal && principal === row.requested_principal_id);
  if (!isRequester) {
    throw new ScopeError("Only the original requester (or the person behind it) can withdraw a deletion request");
  }
  if (row.status !== "pending") throw alreadyDecidedDeletion(row);

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

  try {
    await writeAudit({
      workspaceId: actor.workspaceId,
      actor,
      action: "deletion_request.withdrawn",
      targetType: "deletion_request",
      targetId: row.id,
      before: { status: "pending" },
      after: { status: "withdrawn" },
    });
  } catch (err) {
    await revertDeletionDecision(db, actor, row.id, "withdrawn");
    throw err;
  }

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
  decided_by_label?: string | null;
  decided_principal_id?: string | null;
  /** The content version: the table's trigger bumps it on every edit. */
  updated_at?: string | null;
};

function changeTitle(cr: ChangeRow): string {
  return `Change request ${cr.reference_id ?? cr.id}: ${cr.title}`;
}

/**
 * Four-eyes: record an approve / reject / defer decision on a change request.
 * Rules of the common-pattern answers (2026-10-17):
 *   - Q-GOV-13: approve and reject MUST name the version the decider read
 *     (`expected_updated_at`); a request edited since is refused (412).
 *   - Q-GOV-21: reject and defer MUST carry a reason; approve's is optional (no
 *     filler text is invented for it).
 *   - Q-GOV-24: the same person repeating the same decision is answered "done".
 *   - Q-GOV-23: the decision and its audit row are one database transaction.
 * Guards: scope change:decide; the decider must have a principal; the request
 * must still be raised|under_review (checked, then enforced again as a
 * compare-and-set on the UPDATE so two deciders can't both win); and the
 * decider must be a different HUMAN from the requester (legacy profile-id and
 * actor-typed checks retained).
 */
export async function decideChangeRequest(
  actor: Actor,
  id: string,
  input: { decision: ChangeDecision; rationale?: string | null; expected_updated_at?: string | null },
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
  requireApprover(actor); // D-16: approve, reject and defer are approver verbs

  const newStatus = CHANGE_STATUS[input.decision];
  const rationale = input.rationale?.trim() ? input.rationale.trim() : null;

  if (!(CHANGE_DECIDABLE as readonly string[]).includes(cr.status)) {
    // Q-GOV-24: the same person repeating the same decision (a double tap) gets "done".
    if (cr.status === newStatus && cr.decided_principal_id && cr.decided_principal_id === principal) {
      return {
        result: {
          kind: "change_request",
          id: cr.id,
          status: cr.status,
          title: changeTitle(cr),
          requesterPrincipalId: cr.requested_principal_id,
        },
        row: cr as unknown as Record<string, unknown>,
      };
    }
    throw new RuleError(
      cr.decided_by_label
        ? `Already ${cr.status} by ${cr.decided_by_label}.`
        : `Change request already decided (status: ${cr.status})`,
      "already_decided",
    );
  }

  // Four-eyes. The legacy profile-id column is only ever set for user actors;
  // the actor-typed pair covers tokens/assistants; the principal covers the
  // HUMAN behind either (the case the first two cannot see).
  if (cr.requested_by && actor.id === cr.requested_by) throw selfApprovalError();
  if (isSameActor(actor, cr.requested_by_type, cr.requested_by_id)) throw selfApprovalError();
  assertNotRequesterPrincipal(cr.requested_principal_id, principal);

  // Bait-and-switch guard (Lark red-team): a requester can edit a PENDING
  // request after the approver was shown it. A caller that says which version
  // it saw (`expected_updated_at` — the console sends the value it rendered, a
  // chat card carries the version it was issued for) is refused with 412 if the
  // request has changed since. Opt-in, like every R-90 write: a caller that
  // sends nothing keeps today's behaviour.
  // Q-GOV-21: reject and defer always say why (approve's reason is optional).
  if (!rationale && input.decision !== "approve") {
    throw new RuleError(
      input.decision === "reject" ? REJECT_REASON_REQUIRED_MESSAGE : "Please give a reason for deferring.",
      "rationale_required",
    );
  }

  // Q-GOV-13: approve / reject must carry the version read, on every route.
  if (input.decision !== "defer" && (input.expected_updated_at === undefined || input.expected_updated_at === null)) {
    throw new RuleError(VERSION_REQUIRED_MESSAGE, "version_required");
  }
  try {
    checkOptimisticConcurrency(cr.updated_at, input.expected_updated_at);
  } catch (err) {
    if (err instanceof PreconditionFailedError) throw new PreconditionFailedError(CHANGE_STALE_MESSAGE, err.currentUpdatedAt);
    throw err;
  }

  // The decision and its audit row are ONE database transaction
  // (nopm_decide_change_request, migration 0063): the row is locked, the status
  // compare-and-set and the pinned version re-checked, and change_request.decide
  // is written before the commit — a decision can never exist without its audit
  // row. The function also repeats the approver-role rule (P0018).
  const pinned =
    input.expected_updated_at !== undefined && input.expected_updated_at !== null ? (cr.updated_at ?? null) : null;
  const { data: rpcRow, error: rpcError } = await db.rpc("nopm_decide_change_request", {
    p_id: id,
    p_workspace_id: actor.workspaceId,
    p_new_status: newStatus,
    p_rationale: rationale,
    p_expected_updated_at: pinned,
    p_actor_type: actor.type,
    p_actor_id: actor.id,
    p_actor_label: actor.label,
    p_approver_principal_id: principal,
    p_channel: actor.channel ?? null,
    p_correlation_id: actor.requestId ?? null,
    p_via_connector_id: actor.viaConnectorId ?? null,
    p_external_event_id: actor.externalEventId ?? null,
    p_external_actor_ref: actor.externalActorRef ?? null,
  });
  if (rpcError) {
    const m = `${rpcError.message ?? ""} ${rpcError.code ?? ""}`;
    if (m.includes("NOT_FOUND") || rpcError.code === "P0002") throw new NotFoundError("Change request not found");
    if (m.includes("ALREADY_DECIDED") || rpcError.code === "P0001")
      throw new RuleError("Change request already decided", "already_decided");
    if (m.includes("SELF_APPROVAL") || rpcError.code === "P0003") throw selfApprovalError();
    if (m.includes("NO_PRINCIPAL") || rpcError.code === "P0006") throw new ScopeError(NO_PRINCIPAL_MESSAGE, "no_principal");
    if (m.includes("ROLE_NOT_PERMITTED") || rpcError.code === "P0018")
      throw new ScopeError(APPROVER_ROLE_MESSAGE, "role_not_permitted");
    if (m.includes("PRECONDITION_FAILED") || rpcError.code === "P0021")
      throw new PreconditionFailedError(CHANGE_STALE_MESSAGE);
    throw new Error(rpcError.message || "Failed to record the decision");
  }
  const updated = rpcRow as Record<string, unknown> & { id: string };

  void notify({
    workspaceId: actor.workspaceId,
    recipientIds: noticeRecipients(cr.requested_principal_id ?? cr.requested_by),
    // approve -> approved; reject and defer are not an approval (bell icon + filters bucket on this)
    type: input.decision === "approve" ? "approval.approved" : "approval.rejected",
    title: `Change request ${cr.reference_id ?? cr.id} was ${newStatus}`,
    body: rationale ?? `The change request was ${newStatus}.`,
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

/** The hub event for a change request as it reads NOW (also used when a pending one is edited). */
export async function changeRequestEvent(db: Db, workspaceId: string, cr: ChangeRow): Promise<ApprovalEvent> {
  return {
    workspaceId,
    kind: "change_request",
    id: cr.id,
    title: changeTitle(cr),
    summary: cr.impact_summary ?? cr.description,
    projectId: cr.project_id,
    projectName: await projectNameOf(db, workspaceId, cr.project_id),
    requestedByLabel: storedLabel(cr.requested_by_label, cr.requested_by_type),
    requesterPrincipalId: cr.requested_principal_id,
    // The content version this event (and so its card) describes.
    ...(cr.updated_at ? { version: cr.updated_at } : {}),
  };
}

function changeBaseEvent(db: Db, actor: Actor, cr: ChangeRow): Promise<ApprovalEvent> {
  return changeRequestEvent(db, actor.workspaceId, cr);
}

// ── the single entry point (hub inbound, any future surface) ──────────────

/**
 * Approve or reject a governed request as `actor`. Throws the same ApiErrors
 * the REST routes throw (ScopeError on self-approval / missing principal /
 * missing scope, RuleError when already decided or locked, NotFoundError).
 * `note` is required (non-empty) for "reject" (Q-GOV-21, every route). For "approve"
 * it is optional: deletions record it in the audit row, a change request stores it
 * as its rationale; when none is given nothing is invented (no "Approved via lark").
 *
 * Error `code`s a caller can branch on: `self_approval`, `no_principal`,
 * `already_decided`, `rationale_required`, `forbidden_scope`.
 */
export async function decideApproval(
  actor: Actor,
  ref: ApprovalRef,
  action: "approve" | "reject",
  note?: string,
  opts: { expectedUpdatedAt?: string | null } = {},
): Promise<DecisionResult> {
  const text = note?.trim() ? note.trim() : undefined;
  if (action === "reject" && !text) {
    throw new RuleError(REJECT_REASON_REQUIRED_MESSAGE, "rationale_required");
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
        rationale: text ?? null,
        expected_updated_at: opts.expectedUpdatedAt,
      });
      return out.result;
    }
    default:
      throw new RuleError(`Unsupported approval kind: ${String((ref as { kind: unknown }).kind)}`, "unsupported_kind");
  }
}
