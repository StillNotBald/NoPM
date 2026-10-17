import { createAdminClient } from "@/lib/supabase/admin";
import { changeRequestEvent, projectNameOf } from "@/lib/governance/decide";
import { writeAudit } from "@/lib/audit/write";
import type { Actor } from "@/lib/auth/guard";
import { ACTION_TOKEN_TTL_MS } from "@/lib/integrations/deliveries";
import { runApprovalRequested } from "@/lib/integrations/emit";
import { sanitizeError } from "@/lib/integrations/secrets";
import type { ApprovalEvent, ApprovalKind, ConnectorRow } from "@/lib/integrations/types";

/**
 * D-ACC-7: approval requests raised while the connector was paused (or before
 * it existed) never produced a card, so approvers learned nothing from chat.
 * When an admin RESUMES the connector, queue cards for every request that is
 * still pending.
 *
 * It reuses `runApprovalRequested`, so the same rules apply as for a fresh
 * request: only linked admins/managers, never the requester's own principal,
 * the hourly card budget (the surplus becomes one roll-up message), and the
 * open-card check, which skips any recipient who already holds a live card for
 * that request. A second resume, or a resume while some cards are still open,
 * therefore never produces a duplicate.
 *
 * Bounded per kind (oldest first, 25) and in total (60) and fail-soft per request: one broken row
 * never costs the others their card.
 *
 * Two more callers share the same collection and fan-out (2026-10-17 integration review):
 * `reconcileLostApprovals` (F1, the daily repair of a lost after-commit emit) and
 * `requeueDeadApprovals` (F2, the admin "Requeue dead" action).
 */
export const CATCH_UP_LIMIT_PER_KIND = 25;
/** Hard cap on cards queued per resume, so the background task stays inside the function time limit. */
export const CATCH_UP_TOTAL_CAP = 60;

type Row = Record<string, unknown>;

type CollectOptions = {
  /** Only requests raised at or before this ISO time (the reconciliation grace period). */
  createdBefore?: string;
  /** Only requests raised at or after this ISO time (the reconciliation look-back window). */
  createdAfter?: string;
  /** Only these request ids, per table (requeue-dead looks at specific requests). */
  onlyIds?: { deletions: string[]; changeRequests: string[] };
  limitPerKind?: number;
};

/** Every request of the workspace still waiting for a decision, as a card event, oldest first per kind. */
async function collectPendingEvents(workspaceId: string, opts: CollectOptions = {}): Promise<ApprovalEvent[]> {
  const db = createAdminClient();
  const events: ApprovalEvent[] = [];
  const limit = opts.limitPerKind ?? CATCH_UP_LIMIT_PER_KIND;

  const collect = async (label: string, build: () => PromiseLike<ApprovalEvent[]>): Promise<void> => {
    try {
      events.push(...(await build()));
    } catch (err) {
      console.error(`[integrations] resume catch-up (${label}) failed:`, sanitizeError(err));
    }
  };

  await collect("deletions", async () => {
    if (opts.onlyIds && opts.onlyIds.deletions.length === 0) return [];
    let q = db
      .from("deletion_requests")
      .select("id, target_type, target_id, reason, before, requested_by_type, requested_by_label, requested_principal_id")
      .eq("workspace_id", workspaceId)
      .eq("status", "pending");
    if (opts.createdBefore) q = q.lte("created_at", opts.createdBefore);
    if (opts.createdAfter) q = q.gte("created_at", opts.createdAfter);
    if (opts.onlyIds) q = q.in("id", opts.onlyIds.deletions);
    const { data, error } = await q.order("created_at", { ascending: true }).limit(limit);
    if (error) throw error;
    const out: ApprovalEvent[] = [];
    for (const r of (data ?? []) as Row[]) {
      const isProject = r.target_type === "project";
      if (!isProject && r.target_type !== "task") continue;
      const before = (r.before ?? {}) as Row;
      const name = typeof before.name === "string" ? before.name : String(r.target_id);
      const projectId = isProject ? String(r.target_id) : ((before.project_id as string | undefined) ?? null);
      out.push({
        workspaceId,
        kind: isProject ? "project_deletion" : "task_deletion",
        id: String(r.id),
        title: isProject ? `Delete project "${name}"` : `Delete task "${name}"`,
        summary: (r.reason as string | null) ?? null,
        projectId,
        projectName: isProject ? name : await projectNameOf(db, workspaceId, projectId),
        requestedByLabel: String(r.requested_by_label ?? ""),
        requesterPrincipalId: (r.requested_principal_id as string | null) ?? null,
      });
    }
    return out;
  });

  await collect("change requests", async () => {
    if (opts.onlyIds && opts.onlyIds.changeRequests.length === 0) return [];
    let q = db
      .from("change_requests")
      .select("*")
      .eq("workspace_id", workspaceId)
      .in("status", ["raised", "under_review"]);
    if (opts.createdBefore) q = q.lte("created_at", opts.createdBefore);
    if (opts.createdAfter) q = q.gte("created_at", opts.createdAfter);
    if (opts.onlyIds) q = q.in("id", opts.onlyIds.changeRequests);
    const { data, error } = await q.order("created_at", { ascending: true }).limit(limit);
    if (error) throw error;
    const out: ApprovalEvent[] = [];
    for (const r of (data ?? []) as Row[]) out.push(await changeRequestEvent(db, workspaceId, r as never));
    return out;
  });

  return events;
}

/** Run the card fan-out for these events, fail-soft per request. Returns how many went through. */
async function queueEvents(events: ApprovalEvent[], cap: number, label: string): Promise<number> {
  let queued = 0;
  for (const ev of events.slice(0, cap)) {
    try {
      await runApprovalRequested(ev);
      queued += 1;
    } catch (err) {
      console.error(`[integrations] ${label} card failed:`, sanitizeError(err));
    }
  }
  return queued;
}

export async function catchUpPendingApprovals(workspaceId: string): Promise<{ considered: number }> {
  const events = await collectPendingEvents(workspaceId);
  await queueEvents(events, CATCH_UP_TOTAL_CAP, "resume catch-up");
  return { considered: Math.min(events.length, CATCH_UP_TOTAL_CAP) };
}

// ── shared lookups ─────────────────────────────────────────────────────────

/** Request ids per delivery lookup (they travel in the URL, so the list stays short). */
const ID_CHUNK = 50;

type RequestKey = { kind: ApprovalKind; id: string };
const keyOf = (k: RequestKey) => `${k.kind}:${k.id}`;

/** Requests that already have an approval card on this connector in one of the given statuses. */
async function requestsWithCards(
  connector: Pick<ConnectorRow, "id" | "workspace_id">,
  keys: RequestKey[],
  statuses: string[],
): Promise<Set<string>> {
  const db = createAdminClient();
  const found = new Set<string>();
  for (let i = 0; i < keys.length; i += ID_CHUNK) {
    const chunk = keys.slice(i, i + ID_CHUNK);
    const { data, error } = await db
      .from("integration_deliveries")
      .select("approval_kind, approval_id")
      .eq("workspace_id", connector.workspace_id)
      .eq("connector_id", connector.id)
      .eq("kind", "approval_card")
      .in("status", statuses)
      .in("approval_id", chunk.map((k) => k.id));
    if (error) throw error;
    for (const r of (data ?? []) as { approval_kind: ApprovalKind; approval_id: string }[]) {
      found.add(keyOf({ kind: r.approval_kind, id: r.approval_id }));
    }
  }
  return found;
}

/** The scheduler has no human actor: it is recorded as the connector itself, like the weekly digest. */
function schedulerActor(connector: ConnectorRow): Actor {
  return {
    type: "token",
    id: connector.id,
    label: `${connector.name} (scheduler)`,
    workspaceId: connector.workspace_id,
    channel: "lark",
    viaConnectorId: connector.id,
    principalId: null,
  };
}

// ── F1: reconciliation of a lost emit ──────────────────────────────────────

/** A request younger than this is left to its own after-commit emit, which may still be running. */
export const RECONCILE_MIN_AGE_MS = 5 * 60_000;
/** Requests reconciled per connector per tick, so one workspace cannot eat the whole tick. */
export const RECONCILE_LIMIT_PER_TICK = 20;
/**
 * Pending requests examined per kind per tick. Larger than the send limit on purpose: the oldest
 * pending requests usually already have a card, and a scan as small as the send limit would let
 * twenty carded requests hide every newer lost one (starvation).
 */
export const RECONCILE_SCAN_PER_KIND = 100;
/**
 * Only requests raised within this look-back are repaired. A request that nobody can be told about
 * (every approver unlinked, or the requester is the only approver) never gets a card, so without a
 * bound it would be retried and audited on every daily tick for as long as it stays pending. Older
 * requests are for pause + resume, or the Requeue action.
 */
export const RECONCILE_MAX_AGE_MS = 3 * 24 * 60 * 60_000;

/**
 * The approval card is queued by an after-commit task, so an instance that dies
 * after the governed commit, or a lookup that throws, leaves a pending request
 * that no approver was ever told about. This is the daily repair: for one
 * ACTIVE connector, find pending requests older than a few minutes that have NO
 * approval card on the connector at all (queued, retrying, sent or dead) and
 * run the normal card fan-out for them.
 *
 * Deliberately narrow: a request that has any card is never touched here. A
 * sent card whose token expired is not a lost emit (re-sending it would nag
 * approvers about week-old requests every day), and both a dead card and an
 * expired one are the "Requeue" admin action's job. `runApprovalRequested` still applies its
 * own rules (linked admins/managers only, never the requester, the hourly card
 * budget, the open-card check), so a race with a late emit cannot produce a
 * second card.
 *
 * Bounded and audited BEFORE anything is queued, as the scheduler/connector
 * actor, because it sends request details to a third party. A lookup failure
 * throws so the caller can log it; one request failing does not cost the others.
 */
export async function reconcileLostApprovals(
  connector: ConnectorRow,
  opts: { now?: Date; minAgeMs?: number; maxAgeMs?: number; limit?: number; scan?: number } = {},
): Promise<{ considered: number; queued: number }> {
  if (connector.status !== "active" || !connector.config.approvals.enabled) return { considered: 0, queued: 0 };
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? RECONCILE_LIMIT_PER_TICK;
  const createdBefore = new Date(now.getTime() - (opts.minAgeMs ?? RECONCILE_MIN_AGE_MS)).toISOString();

  const createdAfter = new Date(now.getTime() - (opts.maxAgeMs ?? RECONCILE_MAX_AGE_MS)).toISOString();

  const pending = await collectPendingEvents(connector.workspace_id, {
    createdBefore,
    createdAfter,
    limitPerKind: opts.scan ?? RECONCILE_SCAN_PER_KIND,
  });
  if (pending.length === 0) return { considered: 0, queued: 0 };

  const withCards = await requestsWithCards(connector, pending, ["pending", "retry", "sent", "dead"]);
  const lost = pending.filter((ev) => !withCards.has(keyOf(ev))).slice(0, limit);
  if (lost.length === 0) return { considered: 0, queued: 0 };

  await writeAudit({
    workspaceId: connector.workspace_id,
    actor: schedulerActor(connector),
    action: "integration.approvals.reconcile",
    targetType: "integration_connector",
    targetId: connector.id,
    after: { trigger: "scheduled", requests: lost.map((ev) => ({ kind: ev.kind, id: ev.id })) },
  });
  const queued = await queueEvents(lost, limit, "reconciliation");
  return { considered: lost.length, queued };
}

// ── F2: requeue dead cards ─────────────────────────────────────────────────

/**
 * An admin's "Requeue" action: approval cards that were given up on (after
 * the retry ladder, or because the platform refused them) or whose buttons have
 * expired unclicked (older than the 7-day action-token lifetime) are sent again for
 * every request that is STILL pending. Same fan-out and dedupe as the resume
 * catch-up: an approver who already holds a live card gets nothing new, and the
 * hourly card budget applies. Dead rows are history and stay as they are; the
 * new cards are new rows. Other dead kinds (digests, bot replies, updates for
 * decided requests) are stale by now and are never resent.
 */
export async function requeueDeadApprovals(
  connector: ConnectorRow,
  /** Called with the plan BEFORE any card is queued: the route writes the audit row here (egress is audited first). */
  beforeQueue: (plan: { dead_requests: number; still_pending: number }) => Promise<void>,
): Promise<{ dead_requests: number; still_pending: number }> {
  const db = createAdminClient();
  const cards = () =>
    db
      .from("integration_deliveries")
      .select("approval_kind, approval_id")
      .eq("workspace_id", connector.workspace_id)
      .eq("connector_id", connector.id)
      .eq("kind", "approval_card");
  const { data, error } = await cards().eq("status", "dead").order("created_at", { ascending: true }).limit(CATCH_UP_TOTAL_CAP * 4);
  if (error) throw error;
  // A card that was SENT but never clicked outlives its button after the action-token lifetime: the
  // request is still pending and nobody can act on the old card. Its dedupe (below) only skips
  // approvers who still hold a live card, so an expired one is replaced.
  const expiredBefore = new Date(Date.now() - ACTION_TOKEN_TTL_MS).toISOString();
  const { data: expired, error: expiredError } = await cards()
    .eq("status", "sent")
    .lte("created_at", expiredBefore)
    .order("created_at", { ascending: true })
    .limit(CATCH_UP_TOTAL_CAP * 4);
  if (expiredError) throw expiredError;

  const seen = new Map<string, RequestKey>();
  for (const r of [...(data ?? []), ...(expired ?? [])] as { approval_kind: ApprovalKind | null; approval_id: string | null }[]) {
    if (!r.approval_kind || !r.approval_id) continue;
    seen.set(keyOf({ kind: r.approval_kind, id: r.approval_id }), { kind: r.approval_kind, id: r.approval_id });
  }
  const keys = [...seen.values()].slice(0, CATCH_UP_TOTAL_CAP);
  const onlyIds = {
    deletions: keys.filter((k) => k.kind !== "change_request").map((k) => k.id),
    changeRequests: keys.filter((k) => k.kind === "change_request").map((k) => k.id),
  };
  const events =
    keys.length === 0
      ? []
      : await collectPendingEvents(connector.workspace_id, { onlyIds, limitPerKind: CATCH_UP_TOTAL_CAP });

  const plan = { dead_requests: keys.length, still_pending: events.length };
  await beforeQueue(plan);
  await queueEvents(events, CATCH_UP_TOTAL_CAP, "requeue-dead");
  return plan;
}
