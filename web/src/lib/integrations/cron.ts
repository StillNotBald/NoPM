import { createHash, timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import type { Actor } from "@/lib/auth/guard";
import {
  DELIVERY_COLUMNS,
  DuplicateDeliveryError,
  EMPTY_DRAIN,
  LEASE_MS,
  drainDeliveries,
  insertDeliveries,
  mergeDrain,
  type DrainSummary,
} from "@/lib/integrations/deliveries";
import { gatherDigestData } from "@/lib/integrations/digest-data";
import { sanitizeError } from "@/lib/integrations/secrets";
import { CONNECTOR_COLUMNS, maskExternalId, normalizeConfig } from "@/lib/integrations/store";
import type { ConnectorRow, DeliveryRow } from "@/lib/integrations/types";

/**
 * The daily scheduler tick (Vercel Cron, D6): retry deliveries that are due,
 * send each connector's weekly digest on its configured weekday, and prune old
 * bookkeeping rows.
 *
 * It is a SYSTEM job: it enumerates active connectors across workspaces once,
 * then every other query is scoped to that connector's workspace. Paused and
 * revoked connectors are skipped entirely (the kill switch stops both
 * directions), so their queued rows stay untouched until resumed.
 *
 * It runs inside a serverless time limit (`maxDuration` in the route), so it is
 * built to finish, not to be killed:
 *  - phase 1 queues every connector's digest (database work only, no platform
 *    call), so being cut off later can never lose a week's digest;
 *  - phase 2 drains connectors with bounded concurrency, oldest backlog first,
 *    and stops STARTING work at `CRON_DEADLINE_MS`; each platform call has its
 *    own timeout, and a connector job that overruns is abandoned, not awaited;
 *  - phase 3 prunes retention and only if time remains.
 * Whatever a tick leaves undone is still queued, so the next tick picks it up.
 */

/**
 * Constant-time check of `Authorization: Bearer <CRON_SECRET>`. Fails CLOSED:
 * an unset/empty CRON_SECRET authorises nobody (a missing env var must never
 * turn the cron endpoint into a public trigger). The secret is trimmed like the
 * header is: a trailing newline pasted into the host's env UI must not turn
 * every cron call into a permanent 401.
 */
export function verifyCronAuth(authorization: string | null, secret: string | undefined = process.env.CRON_SECRET): boolean {
  const expected = secret?.trim();
  if (!expected || !authorization) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return false;
  const a = createHash("sha256").update(match[1]).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Monday 00:00 UTC of the ISO week containing `d`. */
export function isoWeekStart(d: Date): Date {
  const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // Mon=1 … Sun=7
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (day - 1)));
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

// ── limits ─────────────────────────────────────────────────────────────────

/**
 * No NEW row or connector is started after this many ms. The route's
 * `maxDuration` is 60 s (a literal in route.ts, Next reads it statically): the
 * deadline plus one platform call (10 s timeout) plus the response must fit
 * under it. cron.test.ts and the route test assert that relation.
 */
export const CRON_DEADLINE_MS = 40_000;
/** How long past the deadline an in-flight connector job is awaited before it is abandoned. */
export const CRON_GRACE_MS = 12_000;
/** Connectors drained at once. Sends inside one connector stay sequential (one app's rate limit). */
export const CRON_CONCURRENCY = 3;
export const CRON_DRAIN_LIMIT = 50;
export const CRON_MAX_PASSES = 10;

/** Retention (days). Only terminal rows are ever pruned; `audit_log` is never touched. */
export const RETENTION = {
  /** `sent` / `dead` / `superseded` deliveries (their action tokens go with them). */
  deliveriesDays: 60,
  /** Action tokens expire after 7 days; this is how long after expiry the row is kept. */
  tokensAfterExpiryDays: 14,
  /** Completed inbound idempotency rows. */
  inboundDays: 90,
  /** Rows deleted per table per workspace per tick. */
  batch: 500,
} as const;

export type PruneSummary = { deliveries: number; action_tokens: number; inbound_actions: number };

export type CronSummary = {
  connectors: number;
  deliveries: DrainSummary;
  /**
   * One count per connector: `sent` (went out), `skipped` (none owed, or already
   * queued this week), `queued` (claimed and waiting: the deadline stopped us
   * before its send, so the next tick delivers it), `failed` (the step threw,
   * or its send failed and it is waiting to retry or is dead).
   */
  digests: { sent: number; skipped: number; queued: number; failed: number };
  /** Connectors the deadline stopped us reaching (their queue is untouched for the next tick). */
  skippedForDeadline: number;
  /** Connector jobs that overran the deadline and were abandoned. */
  timedOut: number;
  pruned: PruneSummary;
  elapsedMs: number;
};

type DigestResult = "sent" | "skipped" | "queued" | "failed";
type ConnectorRun = {
  drain: DrainSummary;
  digest: DigestResult;
  /** The deadline or a timeout cut this connector's pass short: its queue is not necessarily empty. */
  partial: boolean;
};

export async function runCron(
  opts: { now?: Date; deadlineMs?: number; concurrency?: number } = {},
): Promise<CronSummary> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const deadline = started + (opts.deadlineMs ?? CRON_DEADLINE_MS);
  const concurrency = Math.max(1, opts.concurrency ?? CRON_CONCURRENCY);
  const db = createAdminClient();
  const summary: CronSummary = {
    connectors: 0,
    deliveries: { ...EMPTY_DRAIN },
    digests: { sent: 0, skipped: 0, queued: 0, failed: 0 },
    skippedForDeadline: 0,
    timedOut: 0,
    pruned: { deliveries: 0, action_tokens: 0, inbound_actions: 0 },
    elapsedMs: 0,
  };

  const { data, error } = await db
    .from("integration_connectors")
    .select(CONNECTOR_COLUMNS)
    .eq("kind", "lark")
    .eq("status", "active");
  if (error) throw error;
  const found = ((data ?? []) as Record<string, unknown>[]).map(
    (r) => ({ ...(r as unknown as ConnectorRow), config: normalizeConfig(r.config) }),
  );
  summary.connectors = found.length;
  const connectors = await orderByBacklog(found, now);
  const runs = new Map<string, ConnectorRun>(
    connectors.map((c) => [c.id, { drain: { ...EMPTY_DRAIN }, digest: "skipped", partial: false }]),
  );

  // Phase 1: queue every digest (database work only). Cheap, so it is not
  // deadline-gated: the week's digest exists as a queued row before any
  // platform call can run out of time.
  const queuedDigest = new Map<string, string>();
  await mapPool(connectors, concurrency, async (connector) => {
    try {
      const plan = await queueWeeklyDigest(connector, now);
      if (plan.outcome === "queued") queuedDigest.set(connector.id, plan.deliveryId);
    } catch (err) {
      console.error("[integrations] cron digest step failed for a connector:", sanitizeError(err));
      runs.get(connector.id)!.digest = "failed";
    }
  });

  // Phase 2: drain, bounded in concurrency and in time.
  await mapPool(connectors, concurrency, async (connector) => {
    const run = runs.get(connector.id)!;
    if (Date.now() >= deadline) {
      summary.skippedForDeadline += 1;
      run.partial = true;
      return;
    }
    const job = drainConnector(connector, deadline, run.drain);
    const settled = await raceTimeout(job, Math.max(1_000, deadline + CRON_GRACE_MS - Date.now()));
    if (settled === "timeout") {
      summary.timedOut += 1;
      run.partial = true;
      console.error("[integrations] cron connector job overran the deadline and was abandoned", { connectorId: connector.id });
    } else if (settled === "error") {
      // One connector's failure must not starve the others.
      console.error("[integrations] cron tick failed for a connector");
    }
  });

  // Digest outcomes: the queued row is the truth, whoever drained it.
  for (const connector of connectors) {
    const run = runs.get(connector.id)!;
    mergeDrain(summary.deliveries, run.drain);
    if (run.drain.deadlineSkipped > 0) run.partial = true;
    const deliveryId = queuedDigest.get(connector.id);
    if (deliveryId) run.digest = await digestOutcome(connector, deliveryId);
    summary.digests[run.digest] += 1;
  }

  // Phase 3: retention, only with time to spare.
  if (Date.now() < deadline) {
    try {
      summary.pruned = await pruneRetention(connectors, now, deadline);
    } catch (err) {
      console.error("[integrations] cron prune failed:", sanitizeError(err));
    }
  }

  await Promise.all(connectors.map((c) => recordCronRun(c, runs.get(c.id)!)));
  summary.elapsedMs = Date.now() - started;
  return summary;
}

// ── scheduling helpers ─────────────────────────────────────────────────────

/** Run `fn` over `items` with at most `limit` in flight. `fn` must not throw. */
async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** Resolve "timeout" if `work` is still running after `ms`; the work itself is never cancelled. */
async function raceTimeout(work: Promise<void>, ms: number): Promise<"done" | "timeout" | "error"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded = work.then(
    () => "done" as const,
    () => "error" as const,
  );
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([guarded, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Serve the connectors with the OLDEST due backlog first, so a connector that
 * keeps getting cut off by the deadline moves to the front of the next tick
 * instead of starving. Connectors with no backlog go last in their original
 * order. A failed lookup keeps the original order.
 */
async function orderByBacklog(connectors: ConnectorRow[], now: Date): Promise<ConnectorRow[]> {
  if (connectors.length < 2) return connectors;
  try {
    const db = createAdminClient();
    const oldest = new Map<string, string>();
    for (const c of connectors) {
      const { data, error } = await db
        .from("integration_deliveries")
        .select("next_attempt_at")
        .eq("workspace_id", c.workspace_id)
        .eq("connector_id", c.id)
        .in("status", ["pending", "retry"])
        .lte("next_attempt_at", now.toISOString())
        .order("next_attempt_at", { ascending: true })
        .limit(1);
      if (error) return connectors;
      const first = ((data ?? []) as { next_attempt_at: string }[])[0];
      if (first) oldest.set(c.id, first.next_attempt_at);
    }
    return [...connectors].sort((a, b) => {
      const x = oldest.get(a.id);
      const y = oldest.get(b.id);
      if (x && y) return x < y ? -1 : x > y ? 1 : 0;
      return x ? -1 : y ? 1 : 0;
    });
  } catch {
    return connectors;
  }
}

/**
 * Drain one connector page by page until its due backlog is empty or the time is up.
 * The drain runs on the REAL clock, not the tick's start time: phase 1 queued this
 * tick's digest a moment after the tick began, and a drain that looked at an
 * earlier instant would not find it due (it would go out a day late).
 */
async function drainConnector(connector: ConnectorRow, deadline: number, into: DrainSummary): Promise<void> {
  for (let pass = 0; pass < CRON_MAX_PASSES; pass++) {
    if (Date.now() >= deadline) return;
    const drained = await drainDeliveries({
      workspaceId: connector.workspace_id,
      connectorId: connector.id,
      limit: CRON_DRAIN_LIMIT,
      deadline,
    });
    mergeDrain(into, drained);
    // A short page means the due backlog is exhausted; a deadline hit means stop.
    if (drained.claimed < CRON_DRAIN_LIMIT || drained.deadlineSkipped > 0) return;
  }
}

/** Where a digest this tick queued ended up: the row is the truth, whoever drained it. */
async function digestOutcome(connector: ConnectorRow, deliveryId: string): Promise<DigestResult> {
  const { data } = await createAdminClient()
    .from("integration_deliveries")
    .select("status")
    .eq("id", deliveryId)
    .eq("workspace_id", connector.workspace_id)
    .maybeSingle();
  const status = (data as { status?: string } | null)?.status;
  if (status === "sent") return "sent";
  return status === "pending" ? "queued" : "failed";
}

// ── weekly digest ──────────────────────────────────────────────────────────

/** 0 = Monday … 6 = Sunday (ISO order) for a `Date#getUTCDay` value. */
const isoDayIndex = (utcDay: number) => (utcDay + 6) % 7;

/**
 * Is a scheduled digest owed right now?
 *  - "today": today is the configured weekday.
 *  - "catch_up": the weekday already passed this ISO week and the connector's
 *    configuration has not changed since BEFORE that day began, so the digest
 *    was already scheduled when its day arrived and a tick must have missed it
 *    (killed, or the platform skipped the cron). A digest enabled or
 *    re-scheduled after the day passed is never made up: switching it on
 *    midweek must not fire it immediately.
 */
export function digestDue(
  connector: Pick<ConnectorRow, "updated_at">,
  weekday: number,
  now: Date,
): "today" | "catch_up" | "no" {
  const target = isoDayIndex(weekday);
  const today = isoDayIndex(now.getUTCDay());
  if (target === today) return "today";
  if (today > target) {
    const targetStart = isoWeekStart(now).getTime() + target * DAY_MS;
    if (Date.parse(connector.updated_at) < targetStart) return "catch_up";
  }
  return "no";
}

export type DigestPlan = { outcome: "skipped" } | { outcome: "queued"; deliveryId: string };

/**
 * Queue this connector's scheduled digest when one is owed and none exists for
 * the ISO week. ATOMIC: the week's slot is claimed by inserting the delivery
 * row under a unique index (`uniq_scheduled_digest_per_week`, one live
 * scheduled digest per connector per ISO week), so concurrent ticks, or a cron
 * event the platform delivers twice, queue exactly one digest and write one
 * audit row.
 *
 * The winner then audits (BEFORE anything can be sent), gathers the data and
 * releases the row. Until then the row is "held" (`payload.held`): drains skip
 * it, so it can never be sent half-built or unaudited. A tick killed in
 * between leaves a held row whose lease runs out; the next tick RESUMES it
 * (audit again, gather, release) rather than losing the week.
 */
export async function queueWeeklyDigest(connector: ConnectorRow, now: Date): Promise<DigestPlan> {
  const { digest } = normalizeConfig(connector.config);
  const weekKey = ymd(isoWeekStart(now));

  // A claim a dead tick left behind: finish it (this week's), or drop it (an old
  // week's, or any when the digest has been switched off since). Settled BEFORE
  // the enabled check, so a disabled digest cannot strand a held row forever.
  const target = digest.enabled && digest.chatId ? digest.chatId : null;
  const resumed = await resumeAbandonedClaim(connector, target, weekKey, now);
  if (resumed) return resumed;

  if (!target) return { outcome: "skipped" };

  const due = digestDue(connector, digest.weekday, now);
  if (due === "no") return { outcome: "skipped" };

  let held: DeliveryRow;
  try {
    const [row] = await insertDeliveries(connector.workspace_id, connector.id, [
      {
        kind: "digest",
        external_target: target,
        payload: { trigger: "scheduled", week_start: weekKey, held: true },
        locked_until: new Date(now.getTime() + LEASE_MS).toISOString(),
      },
    ]);
    held = row;
  } catch (err) {
    if (err instanceof DuplicateDeliveryError) return { outcome: "skipped" }; // this week's slot is taken
    throw err;
  }
  return completeDigest(connector, held, target, weekKey, now, due === "catch_up");
}

/** Audit, gather and release a held digest. Any failure frees the slot again (nothing was sent). */
async function completeDigest(
  connector: ConnectorRow,
  held: DeliveryRow,
  chatId: string,
  weekKey: string,
  now: Date,
  catchUp: boolean,
): Promise<DigestPlan> {
  const db = createAdminClient();
  try {
    // Egress of workspace data to a third party is audited BEFORE it can be
    // sent, so there is never an unaudited digest. The scheduler has no human
    // actor: it is recorded as the connector itself (actor_type 'token', id =
    // connector).
    const actor: Actor = {
      type: "token",
      id: connector.id,
      label: `${connector.name} (scheduler)`,
      workspaceId: connector.workspace_id,
      channel: "lark",
      viaConnectorId: connector.id,
      principalId: null,
    };
    await writeAudit({
      workspaceId: connector.workspace_id,
      actor,
      action: "integration.digest.send",
      targetType: "integration_connector",
      targetId: connector.id,
      after: { trigger: "scheduled", chat_id: maskExternalId(chatId), week_start: weekKey, ...(catchUp ? { catch_up: true } : {}) },
    });

    const data = await gatherDigestData(connector.workspace_id, { now });
    const { error } = await db
      .from("integration_deliveries")
      // The target is refreshed too: a digest resumed after the admin changed the chat must go to the chat they chose.
      .update({ payload: { trigger: "scheduled", week_start: weekKey, data }, external_target: chatId, locked_until: null })
      .eq("id", held.id)
      .eq("workspace_id", connector.workspace_id);
    if (error) throw error;
  } catch (err) {
    // Nothing left the building: free the slot so a later tick can try again.
    await db.from("integration_deliveries").delete().eq("id", held.id).eq("workspace_id", connector.workspace_id);
    throw err;
  }
  return { outcome: "queued", deliveryId: held.id };
}

/** `chatId` null = the digest is off now: any claim found is dropped, not resumed. */
async function resumeAbandonedClaim(
  connector: ConnectorRow,
  chatId: string | null,
  weekKey: string,
  now: Date,
): Promise<DigestPlan | null> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("integration_deliveries")
    .select(DELIVERY_COLUMNS)
    .eq("workspace_id", connector.workspace_id)
    .eq("connector_id", connector.id)
    .eq("kind", "digest")
    .eq("status", "pending")
    .eq("payload->>trigger", "scheduled")
    .eq("payload->>held", "true")
    .limit(5);
  if (error) throw error;

  let plan: DigestPlan | null = null;
  for (const row of (data ?? []) as unknown as DeliveryRow[]) {
    const nowIso = now.toISOString();
    // Win the right to touch it: only a row whose owner's lease has run out.
    const { data: won } = await db
      .from("integration_deliveries")
      .update({ locked_until: new Date(now.getTime() + LEASE_MS).toISOString() })
      .eq("id", row.id)
      .eq("workspace_id", connector.workspace_id)
      .eq("status", "pending")
      .or(`locked_until.is.null,locked_until.lte.${nowIso}`)
      .select("id");
    if (!won || won.length === 0) continue; // a live tick owns it
    if (row.payload.week_start !== weekKey || !chatId) {
      // A previous week's digest (far too late to send), or one nobody wants any more.
      await db.from("integration_deliveries").delete().eq("id", row.id).eq("workspace_id", connector.workspace_id);
      continue;
    }
    plan = await completeDigest(connector, row, chatId, weekKey, now, true);
  }
  return plan;
}

/**
 * Standalone "queue and send now" for callers outside the tick (kept for the
 * old entry point): same atomic claim, then an immediate drain of that row.
 */
export async function sendWeeklyDigestIfDue(
  connector: ConnectorRow,
  now: Date,
): Promise<"sent" | "skipped" | "failed"> {
  const plan = await queueWeeklyDigest(connector, now);
  if (plan.outcome === "skipped") return "skipped";
  const result = await drainDeliveries({
    workspaceId: connector.workspace_id,
    connectorId: connector.id,
    ids: [plan.deliveryId],
    now,
  });
  return result.sent > 0 ? "sent" : "failed";
}

// ── retention ──────────────────────────────────────────────────────────────

/**
 * Delete old bookkeeping, TERMINAL rows only, in bounded batches per workspace:
 * finished deliveries (their tokens cascade), long-expired action tokens and
 * completed inbound idempotency rows. A queued, retrying or leased delivery is
 * never touched, and neither is `audit_log` (the governed record).
 * Workspaces come from the connector table (any status), so a revoked
 * connector's history is pruned too, and every delete stays workspace-scoped.
 */
export async function pruneRetention(
  active: ConnectorRow[],
  now: Date,
  deadline: number = Number.POSITIVE_INFINITY,
): Promise<PruneSummary> {
  const db = createAdminClient();
  const out: PruneSummary = { deliveries: 0, action_tokens: 0, inbound_actions: 0 };

  const { data, error } = await db.from("integration_connectors").select("workspace_id");
  if (error) throw error;
  const workspaces = new Set<string>([
    ...active.map((c) => c.workspace_id),
    ...((data ?? []) as { workspace_id: string }[]).map((r) => r.workspace_id),
  ]);

  const iso = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  const deleteBatch = async (table: string, workspaceId: string, pick: (q: Q) => Q): Promise<number> => {
    const { data: rows, error: pickError } = await pick(
      db.from(table).select("id").eq("workspace_id", workspaceId),
    ).limit(RETENTION.batch);
    if (pickError) throw pickError;
    const ids = ((rows ?? []) as { id: string }[]).map((r) => r.id);
    if (ids.length === 0) return 0;
    const { data: gone, error: deleteError } = await db
      .from(table)
      .delete()
      .eq("workspace_id", workspaceId)
      .in("id", ids)
      .select("id");
    if (deleteError) throw deleteError;
    return (gone ?? []).length;
  };

  for (const workspaceId of workspaces) {
    if (Date.now() >= deadline) break;
    try {
      out.action_tokens += await deleteBatch("action_tokens", workspaceId, (q) =>
        q.lt("expires_at", iso(RETENTION.tokensAfterExpiryDays)),
      );
      out.deliveries += await deleteBatch("integration_deliveries", workspaceId, (q) =>
        q.in("status", ["sent", "dead", "superseded"]).lt("created_at", iso(RETENTION.deliveriesDays)),
      );
      out.inbound_actions += await deleteBatch("inbound_actions", workspaceId, (q) =>
        q.not("outcome", "is", null).lt("received_at", iso(RETENTION.inboundDays)),
      );
    } catch (err) {
      // Retention is housekeeping: a failed table never fails the tick.
      console.error("[integrations] retention prune failed for a workspace:", sanitizeError(err));
    }
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = any;

// ── operator visibility ────────────────────────────────────────────────────

/** What the admin view shows about the last tick (counts only, never message text). */
export type CronRunView = {
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
  superseded: number;
  digest: DigestResult;
  /** True when the deadline or a timeout cut the pass short, so a backlog may remain for the next tick. */
  partial: boolean;
};

/** Fail-soft: a bookkeeping write must never fail the tick. */
async function recordCronRun(connector: ConnectorRow, run: ConnectorRun): Promise<void> {
  try {
    const db = createAdminClient();
    const view: CronRunView = {
      claimed: run.drain.claimed,
      sent: run.drain.sent,
      retried: run.drain.retried,
      dead: run.drain.dead,
      superseded: run.drain.superseded,
      digest: run.digest,
      partial: run.partial,
    };
    const row = { last_run_at: new Date().toISOString(), last_summary: view };
    const { data, error } = await db
      .from("integration_cron_state")
      .update(row)
      .eq("workspace_id", connector.workspace_id)
      .eq("connector_id", connector.id)
      .select("connector_id");
    if (error) throw error;
    if ((data ?? []).length === 0) {
      const { error: insertError } = await db
        .from("integration_cron_state")
        .insert({ workspace_id: connector.workspace_id, connector_id: connector.id, ...row });
      if (insertError && insertError.code !== "23505") throw insertError;
    }
  } catch (err) {
    console.error("[integrations] could not record the cron run:", sanitizeError(err));
  }
}
