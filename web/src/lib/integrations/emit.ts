import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveWorkspaceApprovers } from "@/lib/notify/publish";
import { drainDeliveries, drainDueRetries, insertDeliveries } from "@/lib/integrations/deliveries";
import { sanitizeError } from "@/lib/integrations/secrets";
import { getActiveConnector } from "@/lib/integrations/store";
import type { ApprovalDecidedEvent, ApprovalEvent, DeliveryRow } from "@/lib/integrations/types";

/**
 * Integration Hub entry points called by the governed request/decision code
 * paths (src/lib/governance/decide.ts and the request-creation routes).
 *
 * Contract (PLAN.md): synchronous, NEVER throw into the caller's mutation,
 * and do all I/O asynchronously (Next.js `after()` when inside a request).
 * They run AFTER the governed change and its audit row are committed, so an
 * integration outage can never block or roll back a governed write — chat
 * delivery is best-effort, the audit log is the record.
 *
 * Fan-out only (D8): `runApprovalRequested` sends a fixed card to each
 * eligible linked approver; `runApprovalDecided` closes the loop on every
 * card. No conditions, no chaining, no templates.
 */
export function emitApprovalRequested(ev: ApprovalEvent): void {
  schedule("approval requested", ev.workspaceId, () => runApprovalRequested(ev));
}

/**
 * Decided statuses that put the request back in front of approvers. A reopened
 * timesheet returns to "submitted": the old cards are closed out like any
 * decision, and approvers get a FRESH card — the governed code emits only a
 * Decided event for a reopen, so the hub treats it as a re-request too.
 */
const REOPEN_STATUSES: ReadonlySet<string> = new Set(["reopened"]);

export function emitApprovalDecided(ev: ApprovalDecidedEvent): void {
  schedule("approval decided", ev.workspaceId, async () => {
    await runApprovalDecided(ev);
    if (REOPEN_STATUSES.has(ev.status)) await runApprovalRequested(ev);
  });
}

/**
 * Run async work after the response when inside a request (`after()` keeps a
 * serverless invocation alive until it settles). `after()` throws outside a
 * request scope (unit tests, scripts, a future queue worker) — there we fall
 * back to a detached promise. Either way the caller never sees an error.
 *
 * After the event's own work, the same invocation also drains a bounded batch
 * of DUE retries for the workspace (see `drainDueRetries`): the daily cron is
 * only the floor of the retry ladder, so retries advance whenever there is
 * traffic. It runs AFTER the primary work so a backlog of failing retries can
 * never delay the card this event is about.
 */
function schedule(label: string, workspaceId: string, task: () => Promise<unknown>): void {
  const run = async () => {
    try {
      await task();
    } catch (err) {
      console.error(`[integrations] ${label} fan-out failed:`, sanitizeError(err));
    }
    try {
      await drainDueRetries(workspaceId);
    } catch (err) {
      console.error(`[integrations] ${label} retry pass failed:`, sanitizeError(err));
    }
  };
  try {
    after(run);
  } catch {
    try {
      void run();
    } catch {
      /* never throw into the governed mutation */
    }
  }
}

/**
 * Resolve recipients and queue one approval card per eligible approver, then
 * drain those rows. Eligible = workspace admin/manager, NOT the requester's
 * HUMAN principal (four-eyes: you never get a card for your own request, even
 * when the request came from your agent token), with an ACTIVE link to a
 * platform identity on the workspace's active connector. Unlinked approvers
 * are skipped — they still see the request in the console and the bell.
 */
export async function runApprovalRequested(ev: ApprovalEvent): Promise<void> {
  const connector = await getActiveConnector(ev.workspaceId);
  if (!connector || !connector.config.approvals.enabled) return;

  const approverIds = (await resolveWorkspaceApprovers(ev.workspaceId)).filter(
    (id) => id !== ev.requesterPrincipalId,
  );
  if (approverIds.length === 0) return;

  const db = createAdminClient();
  const { data: identities, error } = await db
    .from("external_identities")
    .select("profile_id, external_user_id")
    .eq("workspace_id", ev.workspaceId)
    .eq("connector_id", connector.id)
    .is("revoked_at", null)
    .in("profile_id", approverIds);
  if (error) throw error;
  const linked = (identities ?? []) as { profile_id: string; external_user_id: string }[];
  if (linked.length === 0) return;

  // A duplicate emit must not queue a second card for a recipient whose card
  // is still open. (A re-raised request — e.g. a reopened timesheet — has no
  // open card left, because the decision closed the old one.)
  const alreadyOpen = await recipientsWithOpenCard(
    ev,
    connector.id,
    linked.map((l) => l.profile_id),
  );
  const fresh = linked.filter((l) => !alreadyOpen.has(l.profile_id));
  if (fresh.length === 0) return;

  const queued = await insertDeliveries(
    ev.workspaceId,
    connector.id,
    fresh.map((l) => ({
      kind: "approval_card" as const,
      approval_kind: ev.kind,
      approval_id: ev.id,
      recipient_profile_id: l.profile_id,
      external_target: l.external_user_id,
      payload: { event: ev },
    })),
  );

  await drainDeliveries({
    workspaceId: ev.workspaceId,
    connectorId: connector.id,
    ids: queued.map((d) => d.id),
  });
}

async function recipientsWithOpenCard(
  ev: ApprovalEvent,
  connectorId: string,
  profileIds: string[],
): Promise<Set<string>> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("integration_deliveries")
    .select("id, recipient_profile_id, status")
    .eq("workspace_id", ev.workspaceId)
    .eq("connector_id", connectorId)
    .eq("kind", "approval_card")
    .eq("approval_kind", ev.kind)
    .eq("approval_id", ev.id)
    .in("status", ["pending", "retry", "sent"])
    .in("recipient_profile_id", profileIds);
  if (error) throw error;
  const rows = (data ?? []) as { id: string; recipient_profile_id: string; status: string }[];

  const sentIds = rows.filter((r) => r.status === "sent").map((r) => r.id);
  let openSent = new Set<string>();
  if (sentIds.length > 0) {
    // A sent card is still open while one of its tokens is unused + unexpired.
    const { data: tokens, error: tokenError } = await db
      .from("action_tokens")
      .select("delivery_id")
      .eq("workspace_id", ev.workspaceId)
      .eq("approval_kind", ev.kind)
      .eq("approval_id", ev.id)
      .in("delivery_id", sentIds)
      .is("used_at", null)
      .gt("expires_at", new Date().toISOString());
    if (tokenError) throw tokenError;
    openSent = new Set(((tokens ?? []) as { delivery_id: string }[]).map((t) => t.delivery_id));
  }
  return new Set(
    rows.filter((r) => r.status !== "sent" || openSent.has(r.id)).map((r) => r.recipient_profile_id),
  );
}

/**
 * A request was decided from ANY channel (console, CLI, MCP, Lark):
 *  1. Kill every open action token for it — security-critical, so it runs
 *     whatever the connector's state, and a late card click can only ever be a
 *     clean "already decided", never a second mutation.
 *  2. Cards still waiting to be sent are superseded (never sent for a decided
 *     request).
 *  3. Cards already sent (or in flight) get a `decision_update` that patches
 *     them in place to the decided state. A card is patched at most once.
 */
export async function runApprovalDecided(ev: ApprovalDecidedEvent): Promise<void> {
  const db = createAdminClient();
  const nowIso = new Date().toISOString();

  const { error: tokenError } = await db
    .from("action_tokens")
    .update({ used_at: nowIso })
    .eq("workspace_id", ev.workspaceId)
    .eq("approval_kind", ev.kind)
    .eq("approval_id", ev.id)
    .is("used_at", null);
  if (tokenError) throw tokenError;

  const { data: cards, error: cardError } = await db
    .from("integration_deliveries")
    .select("id, connector_id, recipient_profile_id, external_target, status")
    .eq("workspace_id", ev.workspaceId)
    .eq("kind", "approval_card")
    .eq("approval_kind", ev.kind)
    .eq("approval_id", ev.id)
    .in("status", ["pending", "retry", "sent"]);
  if (cardError) throw cardError;
  const all = (cards ?? []) as Pick<
    DeliveryRow,
    "id" | "connector_id" | "recipient_profile_id" | "external_target" | "status"
  >[];
  if (all.length === 0) return;

  // Supersede the unsent, unleased cards. A row a drain claimed between our
  // select and this update keeps its lease, is not returned here, and is
  // treated as in flight below (it gets a decision_update that waits for the
  // card's message id).
  const unsent = all.filter((c) => c.status !== "sent");
  const superseded = new Set<string>();
  if (unsent.length > 0) {
    const { data: done, error: supersedeError } = await db
      .from("integration_deliveries")
      .update({ status: "superseded", last_error: "request decided before delivery" })
      .eq("workspace_id", ev.workspaceId)
      .in("id", unsent.map((c) => c.id))
      .in("status", ["pending", "retry"])
      .or(`locked_until.is.null,locked_until.lte.${nowIso}`)
      .select("id");
    if (supersedeError) throw supersedeError;
    for (const r of (done ?? []) as { id: string }[]) superseded.add(r.id);
  }
  const candidates = all.filter((c) => !superseded.has(c.id));
  if (candidates.length === 0) return;

  const { data: existing, error: childError } = await db
    .from("integration_deliveries")
    .select("parent_delivery_id")
    .eq("workspace_id", ev.workspaceId)
    .eq("kind", "decision_update")
    .in("parent_delivery_id", candidates.map((c) => c.id));
  if (childError) throw childError;
  const patched = new Set(((existing ?? []) as { parent_delivery_id: string }[]).map((r) => r.parent_delivery_id));
  const targets = candidates.filter((c) => !patched.has(c.id));

  const byConnector = new Map<string, typeof targets>();
  for (const t of targets) byConnector.set(t.connector_id, [...(byConnector.get(t.connector_id) ?? []), t]);

  for (const [connectorId, group] of byConnector) {
    const queued = await insertDeliveries(
      ev.workspaceId,
      connectorId,
      group.map((c) => ({
        kind: "decision_update" as const,
        approval_kind: ev.kind,
        approval_id: ev.id,
        recipient_profile_id: c.recipient_profile_id,
        external_target: c.external_target,
        parent_delivery_id: c.id,
        payload: { event: ev },
      })),
    );
    await drainDeliveries({ workspaceId: ev.workspaceId, connectorId, ids: queued.map((d) => d.id) });
  }
}
