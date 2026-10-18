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
import { getWorkspaceTimeZone, shiftToZone } from "@/lib/integrations/time-zone";
import { sanitizeError } from "@/lib/integrations/secrets";
import { EMPTY_NUDGE_STEP, runNudgeStep, type NudgeStepSummary } from "@/lib/nudges/step";
import { CONNECTOR_COLUMNS, maskExternalId, normalizeConfig } from "@/lib/integrations/store";
import type { ConnectorRow, DeliveryRow } from "@/lib/integrations/types";

/**
 * The daily scheduler tick (Vercel Cron, D6): retry deliveries that are due,
 * send each connector's weekly digest on its configured weekday, and prune old
 * bookkeeping rows.
 *
 * It is a SYSTEM job: it enumerates active connectors across workspaces once
 * (keyset-paged, so PostgREST's max_rows cap never hides the tail), then every other query is scoped to that connector's workspace. Paused and
 * revoked connectors are skipped entirely (the kill switch stops both
 * directions), so their queued rows stay untouched until resumed.
 *
 * It runs inside a serverless time limit (`maxDuration` in the route), so it is
 * built to finish, not to be killed:
 *  - phase 1 queues connectors' digests (database work only, no platform call)
 *    before any send, but it stops starting new connectors at the deadline too:
 *    a digest it did not reach is not lost (a connector it skipped is recorded
 *    as partial and goes first next tick, and `digestDue` catches up a missed day);
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
/** Rows per keyset page when enumerating connectors / cron state (below PostgREST's default max_rows of 1000). */
export const CRON_PAGE_SIZE = 500;
/** Connector ids per backlog lookup (they travel in the URL, so the list stays short). */
const BACKLOG_CHUNK = 50;
/** Share of the deadline the ordering lookups may use; past it the remaining connectors keep their id order. */
const ORDERING_BUDGET = 0.25;
/** Workspaces pruned at once. */
const PRUNE_CONCURRENCY = 3;

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
  /** The daily stale-item nudge + weekly report step (R-141 / R-142); runs for every workspace, connector or not. */
  nudges: NudgeStepSummary;
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
    nudges: { ...EMPTY_NUDGE_STEP },
    elapsedMs: 0,
  };

  const found = await loadActiveConnectors(db);
  summary.connectors = found.length;
  const connectors = await orderConnectors(
    found,
    now,
    started + Math.round((opts.deadlineMs ?? CRON_DEADLINE_MS) * ORDERING_BUDGET),
  );
  const runs = new Map<string, ConnectorRun>(
    connectors.map((c) => [c.id, { drain: { ...EMPTY_DRAIN }, digest: "skipped", partial: false }]),
  );

  // Phase 1: queue digests (database work only, no platform call), bounded in
  // concurrency and in time like every other phase. A connector it does not
  // reach before the deadline is flagged partial and sorts to the front of the
  // next tick; its digest is still owed then (today, or caught up by `digestDue`).
  const queuedDigest = new Map<string, string>();
  await mapPool(connectors, concurrency, async (connector) => {
    if (Date.now() >= deadline) {
      runs.get(connector.id)!.partial = true;
      return;
    }
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
  await mapPool(connectors, concurrency, async (connector) => {
    const run = runs.get(connector.id)!;
    mergeDrain(summary.deliveries, run.drain);
    if (run.drain.deadlineSkipped > 0) run.partial = true;
    const deliveryId = queuedDigest.get(connector.id);
    if (deliveryId) {
      try {
        run.digest = await digestOutcome(connector, deliveryId);
      } catch (err) {
        console.error("[integrations] cron digest outcome lookup failed:", sanitizeError(err));
        run.digest = "failed";
      }
    }
    summary.digests[run.digest] += 1;
  });

  // Phase 2b: stale-item nudges + weekly report, per workspace (not per connector). Database
  // work only, before housekeeping so a long prune cannot starve it.
  if (Date.now() < deadline) {
    try {
      summary.nudges = await runNudgeStep(now, deadline);
    } catch (err) {
      console.error("[integrations] cron nudge step failed:", sanitizeError(err));
    }
  }

  // Phase 3: retention, only with time to spare.
  if (Date.now() < deadline) {
    try {
      summary.pruned = await pruneRetention(connectors, now, deadline);
    } catch (err) {
      console.error("[integrations] cron prune failed:", sanitizeError(err));
    }
    // Idempotency-Key reservations older than their 24 h window (migration 0074). Server
    // bookkeeping, not a governed record, so it carries no audit row.
    try {
      const { error } = await db.rpc("nopm_purge_idempotency_keys");
      if (error) throw error;
    } catch (err) {
      console.error("[integrations] idempotency purge failed:", sanitizeError(err));
    }
  }

  // Bookkeeping, bounded: a connector not recorded before the grace window ends keeps its older
  // last_run_at, which only moves it earlier in the next tick's rotation.
  const recordUntil = deadline + CRON_GRACE_MS + 3_000;
  await mapPool(connectors, concurrency * 2, async (connector) => {
    if (Date.now() >= recordUntil) return;
    await recordCronRun(connector, runs.get(connector.id)!);
  });
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

/** Every active Lark connector, keyset-paged by id so a result cap (PostgREST max_rows) can never hide the tail. */
async function loadActiveConnectors(db: ReturnType<typeof createAdminClient>): Promise<ConnectorRow[]> {
  const out: ConnectorRow[] = [];
  let after: string | null = null;
  for (;;) {
    let query: Q = db
      .from("integration_connectors")
      .select(CONNECTOR_COLUMNS)
      .eq("kind", "lark")
      .eq("status", "active")
      .order("id", { ascending: true })
      .limit(CRON_PAGE_SIZE);
    if (after) query = query.gt("id", after);
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []) as Record<string, unknown>[];
    // Stop only on an EMPTY page: a server that caps rows below CRON_PAGE_SIZE returns short pages mid-way.
    if (rows.length === 0) break;
    for (const r of rows) out.push({ ...(r as unknown as ConnectorRow), config: normalizeConfig(r.config) });
    after = String(rows[rows.length - 1].id);
  }
  return out;
}

type CronStateRow = { last_run_at: string; partial: boolean };

/** What earlier ticks recorded per connector (keyset-paged). Throws on a read error; the caller degrades. */
async function loadCronState(): Promise<Map<string, CronStateRow>> {
  const state = new Map<string, CronStateRow>();
  const db = createAdminClient();
  let after: string | null = null;
  for (;;) {
    let query: Q = db
      .from("integration_cron_state")
      .select("connector_id, last_run_at, last_summary")
      .order("connector_id", { ascending: true })
      .limit(CRON_PAGE_SIZE);
    if (after) query = query.gt("connector_id", after);
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []) as { connector_id: string; last_run_at: string; last_summary: { partial?: boolean } | null }[];
    if (rows.length === 0) break;
    for (const r of rows) state.set(r.connector_id, { last_run_at: r.last_run_at, partial: r.last_summary?.partial === true });
    after = rows[rows.length - 1].connector_id;
  }
  return state;
}

/** Oldest due next_attempt_at per connector: one query per few connectors instead of one each. */
async function loadOldestBacklog(connectors: ConnectorRow[], now: Date, until: number): Promise<Map<string, string>> {
  const db = createAdminClient();
  const oldest = new Map<string, string>();
  const chunks: ConnectorRow[][] = [];
  for (let i = 0; i < connectors.length; i += BACKLOG_CHUNK) chunks.push(connectors.slice(i, i + BACKLOG_CHUNK));
  await mapPool(chunks, 4, async (chunk) => {
    if (Date.now() >= until) return;
    try {
      const { data, error } = await db
        .from("integration_deliveries")
        .select("connector_id, next_attempt_at")
        .in("connector_id", chunk.map((c) => c.id))
        .in("status", ["pending", "retry"])
        .lte("next_attempt_at", now.toISOString())
        .order("next_attempt_at", { ascending: true })
        .limit(1000);
      if (error) return;
      for (const r of (data ?? []) as { connector_id: string; next_attempt_at: string }[]) {
        if (!oldest.has(r.connector_id)) oldest.set(r.connector_id, r.next_attempt_at);
      }
    } catch {
      // A failed lookup leaves these connectors unranked; they keep their rotation order.
    }
  });
  return oldest;
}

/**
 * Decide who is served first, so no connector starves when a tick is cut short:
 *  1. connectors with the OLDEST due backlog;
 *  2. connectors the previous tick did not finish (flagged partial) or never recorded;
 *  3. everyone else;
 * the last two by last_run_at ascending (least recently visited first), ties by id.
 * Because every tick stamps the connectors it reaches (`recordCronRun`) and flags the
 * ones it cut short, the order ROTATES tick by tick and every connector is eventually
 * at the front, with no extra storage. A lookup that fails or runs out of its time
 * budget degrades to id order, which is still a complete order.
 */
async function orderConnectors(connectors: ConnectorRow[], now: Date, orderingUntil: number): Promise<ConnectorRow[]> {
  if (connectors.length < 2) return connectors;
  let oldest = new Map<string, string>();
  let state = new Map<string, CronStateRow>();
  oldest = await loadOldestBacklog(connectors, now, orderingUntil);
  try {
    if (Date.now() < orderingUntil) state = await loadCronState();
  } catch (err) {
    console.error("[integrations] cron state unavailable for ordering:", sanitizeError(err));
  }
  const rank = (c: ConnectorRow) => (oldest.has(c.id) ? 0 : !state.get(c.id) || state.get(c.id)!.partial ? 1 : 2);
  return [...connectors].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    const x = ra === 0 ? oldest.get(a.id)! : (state.get(a.id)?.last_run_at ?? "");
    const y = ra === 0 ? oldest.get(b.id)! : (state.get(b.id)?.last_run_at ?? "");
    if (x !== y) return x < y ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
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
  /** Workspace time zone (IANA). Omitted = UTC, the pre-2026-10-17 behaviour. */
  timeZone?: string,
): "today" | "catch_up" | "no" {
  // Run the UTC week maths on workspace wall-clock time (shifted dates).
  const local = timeZone ? shiftToZone(now, timeZone) : now;
  const updated = timeZone ? shiftToZone(new Date(connector.updated_at), timeZone).getTime() : Date.parse(connector.updated_at);
  const target = isoDayIndex(weekday);
  const today = isoDayIndex(local.getUTCDay());
  if (target === today) return "today";
  if (today > target) {
    const targetStart = isoWeekStart(local).getTime() + target * DAY_MS;
    if (updated < targetStart) return "catch_up";
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
  // The weekly digest follows the WORKSPACE time zone (default Malaysia): its
  // weekday and its ISO-week slot are both read on local wall-clock time.
  const timeZone = await getWorkspaceTimeZone(connector.workspace_id);
  const weekKey = ymd(isoWeekStart(shiftToZone(now, timeZone)));

  // A claim a dead tick left behind: finish it (this week's), or drop it (an old
  // week's, or any when the digest has been switched off since). Settled BEFORE
  // the enabled check, so a disabled digest cannot strand a held row forever.
  const target = digest.enabled && digest.chatId ? digest.chatId : null;
  const resumed = await resumeAbandonedClaim(connector, target, weekKey, now, timeZone);
  if (resumed) return resumed;

  if (!target) return { outcome: "skipped" };

  const due = digestDue(connector, digest.weekday, now, timeZone);
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
  return completeDigest(connector, held, target, weekKey, now, due === "catch_up", timeZone);
}

/** Audit, gather and release a held digest. Any failure frees the slot again (nothing was sent). */
async function completeDigest(
  connector: ConnectorRow,
  held: DeliveryRow,
  chatId: string,
  weekKey: string,
  now: Date,
  catchUp: boolean,
  timeZone?: string,
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

    const data = await gatherDigestData(connector.workspace_id, { now, timeZone });
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
  timeZone?: string,
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
    plan = await completeDigest(connector, row, chatId, weekKey, now, true, timeZone);
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

  // Every workspace that has ever had a connector (any status), keyset-paged so a result cap cannot hide the tail.
  const seen = new Set<string>(active.map((c) => c.workspace_id));
  let after: string | null = null;
  for (;;) {
    let query: Q = db
      .from("integration_connectors")
      .select("id, workspace_id")
      .order("id", { ascending: true })
      .limit(CRON_PAGE_SIZE);
    if (after) query = query.gt("id", after);
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []) as { id: string; workspace_id: string }[];
    if (rows.length === 0) break;
    for (const r of rows) seen.add(r.workspace_id);
    after = rows[rows.length - 1].id;
  }
  // Start somewhere different each day (seeded by the date): a tick cut short at the deadline would
  // otherwise always prune the same head of the list and never reach the tail.
  const sorted = [...seen].sort();
  const start = sorted.length === 0 ? 0 : Math.floor(now.getTime() / DAY_MS) % sorted.length;
  const workspaces = [...sorted.slice(start), ...sorted.slice(0, start)];

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

  await mapPool(workspaces, PRUNE_CONCURRENCY, async (workspaceId) => {
    if (Date.now() >= deadline) return;
    try {
      // Read the count only AFTER the await: workspaces run concurrently, so `out.x += await ...` would lose updates.
      const tokens = await deleteBatch("action_tokens", workspaceId, (q) =>
        q.lt("expires_at", iso(RETENTION.tokensAfterExpiryDays)),
      );
      out.action_tokens += tokens;
      const deliveries = await deleteBatch("integration_deliveries", workspaceId, (q) =>
        q.in("status", ["sent", "dead", "superseded"]).lt("created_at", iso(RETENTION.deliveriesDays)),
      );
      out.deliveries += deliveries;
      const inbound = await deleteBatch("inbound_actions", workspaceId, (q) =>
        q.not("outcome", "is", null).lt("received_at", iso(RETENTION.inboundDays)),
      );
      out.inbound_actions += inbound;
    } catch (err) {
      // Retention is housekeeping: a failed table never fails the tick.
      console.error("[integrations] retention prune failed for a workspace:", sanitizeError(err));
    }
  });
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
