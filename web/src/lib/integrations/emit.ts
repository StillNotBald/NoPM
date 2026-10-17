import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveWorkspaceApprovers } from "@/lib/notify/publish";
import { getPendingCounts } from "@/lib/governance/pending-counts";
import {
  DuplicateDeliveryError,
  drainDeliveries,
  drainDueRetries,
  getAdapter,
  insertDeliveries,
  readRequest,
  sameVersion,
  setChangedFollowUp,
  type NewDelivery,
} from "@/lib/integrations/deliveries";
import { sanitizeError } from "@/lib/integrations/secrets";
import { appBaseUrl, getActiveConnector } from "@/lib/integrations/store";
import type { ApprovalDecidedEvent, ApprovalEvent, ConnectorRow, DeliveryRow } from "@/lib/integrations/types";

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

/**
 * A PENDING request's content changed after its approval cards went out (a
 * change request edited by its requester). The old cards describe content that
 * no longer exists and must stop being actionable: their tokens are retired,
 * the cards are patched to "Updated, see the new card", and every approver gets
 * a fresh card carrying the current content and a token bound to the new
 * version. `ev.version` is the request's `updated_at` after the edit (read
 * from the request when absent).
 */
export function emitApprovalChanged(ev: ApprovalEvent): void {
  schedule("approval changed", ev.workspaceId, () => runApprovalChanged(ev));
}

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
export function schedule(label: string, workspaceId: string, task: () => Promise<unknown>): void {
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
  const wanting = linked.filter((l) => !alreadyOpen.has(l.profile_id));
  if (wanting.length === 0) return;

  // One person cannot be buried: past the hourly budget an approver gets a
  // single roll-up message instead of more cards.
  const { fresh, over } = await splitByCardBudget(ev, connector.id, wanting);
  const notices = await queueBacklogNotices(ev, connector, over);

  const cards: NewDelivery[] = fresh.map((l) => ({
    kind: "approval_card" as const,
    approval_kind: ev.kind,
    approval_id: ev.id,
    recipient_profile_id: l.profile_id,
    external_target: l.external_user_id,
    payload: { event: ev },
  }));
  const queued = await insertBatch(ev.workspaceId, connector.id, cards);

  // Not capped: a request with more approvers than one drain page still sends
  // every card (the drain pages the ids itself).
  await drainDeliveries({
    workspaceId: ev.workspaceId,
    connectorId: connector.id,
    ids: [...queued.map((d) => d.id), ...notices.map((d) => d.id)],
  });
}

/** Approval cards one approver may be sent per hour before the roll-up takes over. */
export const CARD_BUDGET_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

type Recipient = { profile_id: string; external_user_id: string };

async function splitByCardBudget(
  ev: ApprovalEvent,
  connectorId: string,
  recipients: Recipient[],
): Promise<{ fresh: Recipient[]; over: Recipient[] }> {
  const db = createAdminClient();
  const since = new Date(Date.now() - HOUR_MS).toISOString();
  const { data, error } = await db
    .from("integration_deliveries")
    .select("recipient_profile_id")
    .eq("workspace_id", ev.workspaceId)
    .eq("connector_id", connectorId)
    .eq("kind", "approval_card")
    .in("recipient_profile_id", recipients.map((r) => r.profile_id))
    .gte("created_at", since)
    .neq("status", "superseded");
  if (error) throw error;
  const sent = new Map<string, number>();
  for (const r of (data ?? []) as { recipient_profile_id: string }[]) {
    sent.set(r.recipient_profile_id, (sent.get(r.recipient_profile_id) ?? 0) + 1);
  }
  const fresh: Recipient[] = [];
  const over: Recipient[] = [];
  for (const r of recipients) {
    if ((sent.get(r.profile_id) ?? 0) >= CARD_BUDGET_PER_HOUR) over.push(r);
    else fresh.push(r);
  }
  return { fresh, over };
}

/**
 * One "N approvals are waiting" message per over-budget approver per hour (the
 * unique index on the hour bucket makes concurrent emits queue it once). The
 * count is what is really waiting on that person, read at send time, not a
 * tally of withheld cards. Fail-soft per person: a missing roll-up never blocks
 * the cards for everyone else.
 */
async function queueBacklogNotices(
  ev: ApprovalEvent,
  connector: ConnectorRow,
  over: Recipient[],
): Promise<DeliveryRow[]> {
  if (over.length === 0) return [];
  const adapter = await getAdapter(connector.kind);
  if (!adapter) return [];
  const db = createAdminClient();
  const hour = new Date().toISOString().slice(0, 13);
  const queued: DeliveryRow[] = [];
  for (const r of over) {
    try {
      let waiting = 0;
      try {
        const counts = await getPendingCounts(db, { userId: r.profile_id, workspaceId: ev.workspaceId });
        waiting = counts.approvals + counts.changeControl;
      } catch {
        waiting = 0;
      }
      const body = adapter.renderBacklogNotice({ waiting, limit: CARD_BUDGET_PER_HOUR, appUrl: appBaseUrl() });
      queued.push(
        ...(await insertDeliveries(ev.workspaceId, connector.id, [
          {
            kind: "bot_reply",
            recipient_profile_id: r.profile_id,
            external_target: r.external_user_id,
            payload: { receiveIdType: "open_id", body, notice: "backlog", notice_hour: hour },
          },
        ])),
      );
    } catch (err) {
      if (!(err instanceof DuplicateDeliveryError)) {
        console.error("[integrations] backlog notice failed:", sanitizeError(err));
      }
    }
  }
  return queued;
}

/**
 * Queue deliveries in one statement. If a concurrent duplicate emit already
 * queued one of them (a unique backstop refuses the whole batch), fall back
 * to one row at a time and skip only the duplicates, so a single raced
 * row cannot cost the other recipients theirs.
 */
async function insertBatch(workspaceId: string, connectorId: string, rows: NewDelivery[]) {
  try {
    return await insertDeliveries(workspaceId, connectorId, rows);
  } catch (err) {
    if (!(err instanceof DuplicateDeliveryError)) throw err;
  }
  const queued = [];
  for (const row of rows) {
    try {
      queued.push(...(await insertDeliveries(workspaceId, connectorId, [row])));
    } catch (err) {
      if (!(err instanceof DuplicateDeliveryError)) throw err;
    }
  }
  return queued;
}

async function recipientsWithOpenCard(
  ev: ApprovalEvent,
  connectorId: string,
  profileIds: string[],
): Promise<Set<string>> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("integration_deliveries")
    .select("id, recipient_profile_id, status, payload")
    .eq("workspace_id", ev.workspaceId)
    .eq("connector_id", connectorId)
    .eq("kind", "approval_card")
    .eq("approval_kind", ev.kind)
    .eq("approval_id", ev.id)
    .in("status", ["pending", "retry", "sent"])
    .in("recipient_profile_id", profileIds);
  if (error) throw error;
  const rows = (data ?? []) as { id: string; recipient_profile_id: string; status: string; payload: Record<string, unknown> | null }[];

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
  // A card still waiting in the queue is "open" only for the content version it
  // was queued with: one queued for an older version is stale and must not
  // suppress the card for the current one.
  const queuedVersion = (r: { payload: Record<string, unknown> | null }) =>
    ((r.payload?.event as ApprovalEvent | undefined)?.version ?? null);
  return new Set(
    rows
      .filter((r) => (r.status === "sent" ? openSent.has(r.id) : sameVersion(queuedVersion(r), ev.version ?? null)))
      .map((r) => r.recipient_profile_id),
  );
}

/**
 * A pending request was EDITED after its cards went out. Order matters:
 *  1. Retire every open token bound to another version, whatever the
 *     connector's state (security-critical, like the decision path): a tap on
 *     an old card can no longer approve the new content.
 *  2. Cards of another version still waiting to be sent are superseded; cards
 *     already sent, or in flight, are patched in place to "Updated, see the new
 *     card" (once per card, like the decision patch).
 *  3. Approvers get a fresh card with the current content (the normal fan-out;
 *     a recipient whose old card was mid-send gets theirs when that send
 *     settles, via the follow-up registered below).
 */
export async function runApprovalChanged(input: ApprovalEvent): Promise<void> {
  const db = createAdminClient();
  const version =
    input.version ?? (await readRequest({ workspace_id: input.workspaceId, approval_kind: input.kind, approval_id: input.id })).version;
  const ev: ApprovalEvent = { ...input, version };
  const nowIso = new Date().toISOString();

  let retire = db
    .from("action_tokens")
    .update({ used_at: nowIso, superseded_reason: "changed" })
    .eq("workspace_id", ev.workspaceId)
    .eq("approval_kind", ev.kind)
    .eq("approval_id", ev.id)
    .is("used_at", null);
  if (version) retire = retire.or(`approval_version.is.null,approval_version.neq.${version}`);
  const { error: tokenError } = await retire;
  if (tokenError) throw tokenError;

  const { data: cards, error: cardError } = await db
    .from("integration_deliveries")
    .select("id, connector_id, recipient_profile_id, external_target, status, payload")
    .eq("workspace_id", ev.workspaceId)
    .eq("kind", "approval_card")
    .eq("approval_kind", ev.kind)
    .eq("approval_id", ev.id)
    .in("status", ["pending", "retry", "sent"]);
  if (cardError) throw cardError;
  const stale = ((cards ?? []) as (Pick<DeliveryRow, "id" | "connector_id" | "recipient_profile_id" | "external_target" | "status"> & {
    payload: Record<string, unknown> | null;
  })[]).filter((c) => !sameVersion(((c.payload?.event as ApprovalEvent | undefined)?.version ?? null), version));

  const unsent = stale.filter((c) => c.status !== "sent");
  const superseded = new Set<string>();
  if (unsent.length > 0) {
    const { data: done, error: supersedeError } = await db
      .from("integration_deliveries")
      .update({ status: "superseded", last_error: "request changed before delivery" })
      .eq("workspace_id", ev.workspaceId)
      .in("id", unsent.map((c) => c.id))
      .in("status", ["pending", "retry"])
      .or(`locked_until.is.null,locked_until.lte.${nowIso}`)
      .select("id");
    if (supersedeError) throw supersedeError;
    for (const r of (done ?? []) as { id: string }[]) superseded.add(r.id);
  }
  const candidates = stale.filter((c) => !superseded.has(c.id));

  if (candidates.length > 0) {
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
      const queued = await insertBatch(
        ev.workspaceId,
        connectorId,
        group.map((c) => ({
          kind: "decision_update" as const,
          approval_kind: ev.kind,
          approval_id: ev.id,
          recipient_profile_id: c.recipient_profile_id,
          external_target: c.external_target,
          parent_delivery_id: c.id,
          payload: { event: ev, variant: "changed" },
        })),
      );
      await drainDeliveries({ workspaceId: ev.workspaceId, connectorId, ids: queued.map((d) => d.id) });
    }
  }

  await runApprovalRequested(ev);
}

// A card whose send was still in flight when its request was edited is patched
// when that send settles; that is also the moment its replacement can be issued.
setChangedFollowUp(runApprovalRequested);

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
    const queued = await insertBatch(
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
