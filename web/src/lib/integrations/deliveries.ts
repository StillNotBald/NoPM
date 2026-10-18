import { createAdminClient } from "@/lib/supabase/admin";
import { deriveActionToken, sanitizeError } from "@/lib/integrations/secrets";
import { appBaseUrl, getConnector, loadConnectorSecrets } from "@/lib/integrations/store";
import type {
  ApprovalDecidedEvent,
  ApprovalEvent,
  ApprovalKind,
  ConnectorAdapter,
  ConnectorRow,
  DeliveryKind,
  DeliveryRow,
  DigestData,
  LarkSecrets,
  OutboundMessage,
} from "@/lib/integrations/types";

/**
 * Integration Hub — the outbound delivery queue.
 *
 * Producers (emit.ts, cron.ts, the digest route) INSERT `integration_deliveries`
 * rows; `drainDeliveries` claims due rows, renders + sends them through the
 * platform adapter, and records the result. Nothing here makes a governance
 * decision, and nothing here can block or roll back a governed write: chat
 * delivery is best-effort, the audit log is the record.
 *
 * Delivery is AT-LEAST-ONCE and crash-safe:
 *  - A row is claimed with a lease (`locked_until`) by a conditional UPDATE
 *    (`where status in (pending, retry), the row is due, and its lease is free`). Postgres
 *    re-evaluates the WHERE after waiting on a concurrent writer, so two
 *    drains (an `after()` run racing the daily cron) can never both claim the
 *    same row. A drain killed mid-send simply lets its lease expire.
 *  - The lease is computed from the clock AT CLAIM TIME, not from when the
 *    drain started (a long drain would otherwise hand out already-expired
 *    leases), and it is renewed, compare-and-set, immediately before each
 *    platform call: a drain that finds it no longer owns the row does not send.
 *  - Failures retry on 1m, 5m, 30m, 2h, 12h, then the row goes `dead`. A
 *    non-retryable adapter result (bad credentials, invalid target) goes dead
 *    immediately. `last_error` is sanitised + truncated: never a secret,
 *    never a message body.
 *  - ONE delivery = ONE card = ONE action token. The token is derived from the
 *    delivery id (see `deriveActionToken`), so every retry carries the same
 *    card and the same token, and the delivery id doubles as the platform's
 *    idempotency key: a retry of a send that actually landed returns the
 *    original message instead of creating a second card. Only the token's
 *    SHA-256 is stored.
 *  - A card is never sent for a request that is no longer pending (checked
 *    just before the token is minted), and a request that is decided WHILE its
 *    card is in flight is reconciled the moment the send settles: the stray
 *    token is killed and the queued `decision_update` runs at once instead of
 *    waiting for the next drain.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Delay before retry N (index = failed attempts so far - 1). */
export const RETRY_DELAYS_MS = [1 * MINUTE, 5 * MINUTE, 30 * MINUTE, 2 * HOUR, 12 * HOUR] as const;
/** First attempt + one per retry delay; the failure after this many goes dead. */
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** How long a drain owns a claimed row before another drain may take it. */
export const LEASE_MS = 2 * MINUTE;
export const ACTION_TOKEN_TTL_MS = 7 * 24 * HOUR;
/** The platform refuses to edit a card more than 14 days after it was sent. */
export const CARD_EDIT_WINDOW_MS = 14 * 24 * HOUR;
export const ACTION_TOKEN_PREFIX = "npa_";
/** Rows an UNSCOPED drain takes per pass. A drain restricted to `ids` is never capped. */
export const DEFAULT_DRAIN_LIMIT = 25;
/** `ids` per query: a PostgREST `in.(...)` list rides in the URL, so a big fan-out is paged. */
export const ID_BATCH = 50;

export const DELIVERY_COLUMNS =
  "id, workspace_id, connector_id, kind, approval_kind, approval_id, recipient_profile_id, external_target, parent_delivery_id, payload, status, attempts, next_attempt_at, locked_until, external_message_id, last_error, created_at, sent_at" as const;

/** What happens to a row after `attemptsDone` attempts have ended in failure. */
export function planAfterFailure(
  attemptsDone: number,
  retryable: boolean,
  now: Date,
): { status: "retry"; nextAttemptAt: Date } | { status: "dead" } {
  if (!retryable || attemptsDone >= MAX_ATTEMPTS) return { status: "dead" };
  const delay = RETRY_DELAYS_MS[Math.max(0, attemptsDone - 1)];
  return { status: "retry", nextAttemptAt: new Date(now.getTime() + delay) };
}

// ── adapter registry (injectable for tests) ────────────────────────────────

const adapters = new Map<string, ConnectorAdapter>();

export function registerAdapter(adapter: ConnectorAdapter): void {
  adapters.set(adapter.kind, adapter);
}

/** Test helper: forget every registered adapter. */
export function clearAdapters(): void {
  adapters.clear();
}

/**
 * Resolve the adapter for a connector kind. A registered adapter wins (tests,
 * future kinds); otherwise the Lark adapter is imported lazily so the hub core
 * has no load-time dependency on the platform SDK.
 */
export async function getAdapter(kind: ConnectorRow["kind"]): Promise<ConnectorAdapter | null> {
  const hit = adapters.get(kind);
  if (hit) return hit;
  if (kind === "lark") {
    try {
      const mod = await import("@/lib/integrations/lark");
      if (mod.larkAdapter) {
        adapters.set("lark", mod.larkAdapter);
        return mod.larkAdapter;
      }
    } catch (err) {
      console.error("[integrations] lark adapter unavailable:", sanitizeError(err));
    }
  }
  return null;
}

// ── producers ──────────────────────────────────────────────────────────────

export type NewDelivery = {
  kind: DeliveryKind;
  approval_kind?: ApprovalKind | null;
  approval_id?: string | null;
  recipient_profile_id?: string | null;
  external_target?: string | null;
  parent_delivery_id?: string | null;
  payload: Record<string, unknown>;
  /** ISO time until which no drain may take the row (a producer still completing it). */
  locked_until?: string | null;
};

/** A unique index refused the row (23505): the slot is already taken. */
export class DuplicateDeliveryError extends Error {
  constructor(detail: string) {
    super(`Failed to queue deliveries: ${detail}`);
    this.name = "DuplicateDeliveryError";
  }
}

/**
 * Queue deliveries (status pending, due now). Returns the inserted rows. The due
 * time is stamped here, from the app clock, because that is the clock a drain
 * compares it with: the column default is the database host's clock, and a host
 * running ahead would hide a brand-new card from the drain that was meant to
 * send it.
 */
export async function insertDeliveries(
  workspaceId: string,
  connectorId: string,
  rows: NewDelivery[],
): Promise<DeliveryRow[]> {
  if (rows.length === 0) return [];
  const db = createAdminClient();
  const dueAt = new Date().toISOString();
  const { data, error } = await db
    .from("integration_deliveries")
    .insert(
      rows.map((r) => ({
        workspace_id: workspaceId,
        connector_id: connectorId,
        kind: r.kind,
        approval_kind: r.approval_kind ?? null,
        approval_id: r.approval_id ?? null,
        recipient_profile_id: r.recipient_profile_id ?? null,
        external_target: r.external_target ?? null,
        parent_delivery_id: r.parent_delivery_id ?? null,
        payload: r.payload,
        next_attempt_at: dueAt,
        ...(r.locked_until ? { locked_until: r.locked_until } : {}),
      })),
    )
    .select(DELIVERY_COLUMNS);
  if (error) {
    if (error.code === "23505") throw new DuplicateDeliveryError(error.message);
    throw new Error(`Failed to queue deliveries: ${error.message}`);
  }
  return (data ?? []) as unknown as DeliveryRow[];
}

/** Queue a pre-rendered direct message / group message (e.g. a bot command reply). */
export async function enqueueBotReply(
  connector: Pick<ConnectorRow, "id" | "workspace_id">,
  msg: OutboundMessage,
): Promise<DeliveryRow | null> {
  const [row] = await insertDeliveries(connector.workspace_id, connector.id, [
    {
      kind: "bot_reply",
      external_target: msg.receiveId,
      payload: { receiveIdType: msg.receiveIdType, body: msg.body },
    },
  ]);
  return row ?? null;
}

/**
 * Queue a digest for the connector's configured group chat. `trigger` tags the
 * row: only "scheduled" rows occupy the once-per-ISO-week slot, so a manual
 * "send now" never suppresses the scheduled one. (Scheduled digests are queued
 * by cron.ts through the atomic slot claim, not through this function.)
 */
export async function enqueueDigest(
  connector: Pick<ConnectorRow, "id" | "workspace_id">,
  chatId: string,
  data: DigestData,
  trigger: "scheduled" | "manual",
): Promise<DeliveryRow | null> {
  const [row] = await insertDeliveries(connector.workspace_id, connector.id, [
    { kind: "digest", external_target: chatId, payload: { data, trigger } },
  ]);
  return row ?? null;
}

/**
 * A scheduled digest whose producer has claimed the week's slot but not yet
 * audited and filled it. Drains skip it: it has no data to render, and it must
 * not leave the building before its audit row exists.
 */
export function isHeldDelivery(row: Pick<DeliveryRow, "payload">): boolean {
  return row.payload?.held === true;
}

// ── action tokens ──────────────────────────────────────────────────────────

/**
 * Register the single-use token a card carries. Bound to ONE recipient, ONE
 * approval and the content VERSION the card was rendered from; only its SHA-256
 * is stored. Returns the raw value, which must go straight into the card and
 * nowhere else (never logged, never persisted).
 *
 * The raw value is derived from the delivery id, so calling this again for a
 * retry yields the same token and the insert collides on `token_hash`
 * (unique): the existing row is the token, and nothing new is minted. Its
 * version stays the one it was first bound to.
 */
async function mintActionToken(row: DeliveryRow, version: string | null): Promise<string> {
  if (!row.recipient_profile_id || !row.approval_kind || !row.approval_id) {
    throw new Error("Approval card delivery is missing its recipient or approval reference");
  }
  const { raw, hash } = deriveActionToken(row.id, ACTION_TOKEN_PREFIX);
  const db = createAdminClient();
  const { error } = await db.from("action_tokens").insert({
    workspace_id: row.workspace_id,
    delivery_id: row.id,
    recipient_profile_id: row.recipient_profile_id,
    approval_kind: row.approval_kind,
    approval_id: row.approval_id,
    approval_version: version,
    token_hash: hash,
    expires_at: new Date(Date.now() + ACTION_TOKEN_TTL_MS).toISOString(),
  });
  if (error && error.code !== "23505") throw new Error(`Failed to mint action token: ${error.message}`);
  return raw;
}

// ── request state (the pre-send check) ─────────────────────────────────────

/**
 * Where each approval kind lives, which statuses still await a decision, and
 * whether its rows carry a content version. Change requests have an
 * `updated_at` their table's trigger bumps on every write;
 * deletion requests are immutable once raised, so there is nothing to bind to.
 */
const REQUEST_SOURCES: Record<ApprovalKind, { table: string; pending: readonly string[]; versioned: boolean }> = {
  task_deletion: { table: "deletion_requests", pending: ["pending"], versioned: false },
  project_deletion: { table: "deletion_requests", pending: ["pending"], versioned: false },
  change_request: { table: "change_requests", pending: ["raised", "under_review"], versioned: true },
  rebaseline_signoff: { table: "rebaselines", pending: ["pending_approval"], versioned: false },
};

export type RequestState = "pending" | "decided" | "missing";

/** Does this kind have a content version at all? */
export function isVersionedKind(kind: ApprovalKind): boolean {
  return REQUEST_SOURCES[kind]?.versioned === true;
}

/**
 * Two content versions are the same when both are absent, or both parse to the
 * same instant (a value that took a trip through JSON loses microseconds, so
 * millisecond equality counts). One absent and one present is a difference.
 */
export function sameVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  if (x === y) return true;
  const mx = Date.parse(x);
  const my = Date.parse(y);
  return !Number.isNaN(mx) && mx === my;
}

/**
 * The governed request behind a card: is it still waiting for a decision, and
 * which content version is it at? One workspace-filtered primary-key read.
 * Throws on a database error: the caller must treat "could not tell" as a
 * retryable failure, never as "pending".
 */
export async function readRequest(
  row: Pick<DeliveryRow, "workspace_id" | "approval_kind" | "approval_id">,
): Promise<{ state: RequestState; version: string | null }> {
  if (!row.approval_kind || !row.approval_id) return { state: "missing", version: null };
  const source = REQUEST_SOURCES[row.approval_kind];
  if (!source) return { state: "missing", version: null };
  const db = createAdminClient();
  const { data, error } = await db
    .from(source.table)
    .select(source.versioned ? "status, updated_at" : "status")
    .eq("id", row.approval_id)
    .eq("workspace_id", row.workspace_id)
    .maybeSingle();
  if (error) throw new Error(`Failed to read request state: ${error.message}`);
  if (!data) return { state: "missing", version: null };
  const found = data as unknown as { status: string; updated_at?: string | null };
  return {
    state: source.pending.includes(found.status) ? "pending" : "decided",
    version: source.versioned ? (found.updated_at ?? null) : null,
  };
}

export async function requestState(
  row: Pick<DeliveryRow, "workspace_id" | "approval_kind" | "approval_id">,
): Promise<RequestState> {
  return (await readRequest(row)).state;
}

// ── drain ──────────────────────────────────────────────────────────────────

/** How many due retries an event-triggered drain will also pick up. */
export const OPPORTUNISTIC_RETRY_BATCH = 10;

export type DrainOptions = {
  /** Required: every drain is scoped to one workspace. */
  workspaceId: string;
  connectorId?: string;
  /** Restrict to these delivery ids (the rows an emit just queued). Not capped. */
  ids?: string[];
  /** Cap for an UNSCOPED drain (default DEFAULT_DRAIN_LIMIT). Ignored when `ids` is given. */
  limit?: number;
  /**
   * The drain's notion of "now". The clock advances from it as real time passes
   * and is never behind the real clock, so a caller that captured `now` at the
   * start of a long job cannot hide rows queued since. A `now` AHEAD of real
   * time is honoured (it lets a caller look at what will be due).
   */
  now?: Date;
  /** Epoch ms after which no NEW row is started (a row already in flight finishes). */
  deadline?: number;
};

export type DrainSummary = {
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
  superseded: number;
  /** Released unsent (connector paused). */
  deferred: number;
  /** Candidates left untouched because the deadline passed. */
  deadlineSkipped: number;
};

export const EMPTY_DRAIN: Readonly<DrainSummary> = {
  claimed: 0,
  sent: 0,
  retried: 0,
  dead: 0,
  superseded: 0,
  deferred: 0,
  deadlineSkipped: 0,
};

export function mergeDrain(into: DrainSummary, from: DrainSummary): void {
  for (const k of Object.keys(EMPTY_DRAIN) as (keyof DrainSummary)[]) into[k] += from[k];
}

type Attempt =
  | { kind: "sent"; externalMessageId: string | null }
  | { kind: "failed"; retryable: boolean; error: string; waitingOnParent?: boolean }
  | { kind: "superseded"; reason: string }
  | { kind: "deferred" }
  /** This drain no longer owns the row's lease: someone else may be sending it. Touch nothing. */
  | { kind: "lost" };

type Clock = () => Date;

/** A lease this drain holds; `value` follows every renewal. */
type Lease = { value: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = any;

/**
 * `base` plus the real time elapsed since this call, but never behind the real
 * clock: deterministic under fake timers, never stale. A caller's `base` can be
 * older than rows it queued itself (a cron tick that began before it queued its
 * digest), and those must be due.
 */
function makeClock(base?: Date): Clock {
  if (!base) return () => new Date();
  const origin = Date.now();
  return () => new Date(Math.max(base.getTime() + (Date.now() - origin), Date.now()));
}

export async function drainDeliveries(opts: DrainOptions): Promise<DrainSummary> {
  if (opts.ids && opts.ids.length > ID_BATCH) {
    const total: DrainSummary = { ...EMPTY_DRAIN };
    for (let i = 0; i < opts.ids.length; i += ID_BATCH) {
      mergeDrain(total, await drainOnce({ ...opts, ids: opts.ids.slice(i, i + ID_BATCH) }, true));
    }
    return total;
  }
  return drainOnce(opts, true);
}

/**
 * One pass over the due rows. `inline` allows the two same-pass follow-ups (a
 * decision patch that was waiting on its card; a decided-during-send card), and
 * is switched off for the passes those follow-ups themselves run, so they can
 * never recurse.
 */
async function drainOnce(opts: DrainOptions, inline: boolean): Promise<DrainSummary> {
  const clock = makeClock(opts.now);
  const summary: DrainSummary = { ...EMPTY_DRAIN };
  if (opts.ids && opts.ids.length === 0) return summary;
  const db = createAdminClient();
  const nowIso = clock().toISOString();

  let query: Q = db
    .from("integration_deliveries")
    .select(DELIVERY_COLUMNS)
    .eq("workspace_id", opts.workspaceId)
    .in("status", ["pending", "retry"])
    .lte("next_attempt_at", nowIso)
    .or(`locked_until.is.null,locked_until.lte.${nowIso}`)
    .order("next_attempt_at", { ascending: true });
  if (opts.connectorId) query = query.eq("connector_id", opts.connectorId);
  if (opts.ids) query = query.in("id", opts.ids).limit(opts.ids.length);
  else query = query.limit(opts.limit ?? DEFAULT_DRAIN_LIMIT);

  const { data: candidates, error } = await query;
  if (error) {
    console.error("[integrations] drain select failed:", sanitizeError(error));
    return summary;
  }

  // Read per row, never cached for the drain: a drain can run for minutes, and
  // the kill switch (or a credential change) must stop the very next send.
  const loadConnector = (row: DeliveryRow): Promise<ConnectorRow | null> => getConnector(row.workspace_id, row.connector_id);

  const queue = ((candidates ?? []) as unknown as DeliveryRow[]).filter((c) => !isHeldDelivery(c));
  for (let i = 0; i < queue.length; i++) {
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
      summary.deadlineSkipped += queue.length - i;
      break;
    }
    const claimed = await claim(queue[i], clock);
    if (!claimed) continue; // another drain owns it
    const { row, lease } = claimed;
    summary.claimed += 1;

    let secrets: LarkSecrets | null = null;
    let attempt: Attempt;
    try {
      const connector = await loadConnector(row);
      if (!connector || connector.status === "revoked") {
        attempt = { kind: "superseded", reason: "connector revoked" };
      } else if (connector.status === "paused") {
        attempt = { kind: "deferred" };
      } else {
        try {
          secrets = loadConnectorSecrets(connector);
        } catch {
          secrets = null;
        }
        attempt = secrets
          ? await attemptDelivery(row, connector, secrets, { clock, lease })
          : { kind: "failed", retryable: true, error: "Connector secrets are unreadable (check the encryption key)" };
      }
    } catch (err) {
      attempt = {
        kind: "failed",
        retryable: true,
        error: sanitizeError(err, [secrets?.appSecret, secrets?.verificationToken, secrets?.encryptKey]),
      };
    }

    await settle(row, attempt, clock, summary);

    if (!inline) continue;
    try {
      if (attempt.kind === "sent" && row.kind === "approval_card") {
        await reconcileDecidedDuringSend(row, clock, summary);
      } else if (attempt.kind === "failed" && attempt.waitingOnParent) {
        await retryUpdateIfCardSettled(row, clock, summary);
      }
    } catch (err) {
      console.error("[integrations] post-send reconcile failed:", sanitizeError(err));
    }
  }
  return summary;
}

/**
 * Opportunistic retry pass for a workspace: drain a bounded batch of rows that
 * are DUE (pending or retry) and whose lease is free. Called after every
 * event-triggered drain so retries progress whenever there is traffic — the
 * daily cron alone cannot honour a 1m/5m/30m ladder; it is the floor, this is
 * the accelerator. Same claim lease as every other drain, so it can never
 * double-send with a concurrent run.
 */
export async function drainDueRetries(workspaceId: string, now: Date = new Date()): Promise<DrainSummary> {
  return drainDeliveries({ workspaceId, limit: OPPORTUNISTIC_RETRY_BATCH, now });
}

/**
 * Claim one row with a lease. Null when someone else holds it or it is no
 * longer due. Both the "is the lease free" test and the new lease are measured
 * from the clock NOW, not from when the drain began. "Due" is re-tested here,
 * not only at selection: a drain's candidate list can be stale by the time it
 * reaches a row, and a row another drain just failed is not due again until
 * its retry time (claiming it anyway would spend the retry ladder in minutes).
 */
async function claim(row: DeliveryRow, clock: Clock): Promise<{ row: DeliveryRow; lease: Lease } | null> {
  const db = createAdminClient();
  const now = clock();
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
  const { data, error } = await db
    .from("integration_deliveries")
    .update({ locked_until: leaseUntil })
    .eq("id", row.id)
    .eq("workspace_id", row.workspace_id)
    .in("status", ["pending", "retry"])
    .lte("next_attempt_at", nowIso)
    .or(`locked_until.is.null,locked_until.lte.${nowIso}`)
    .select(DELIVERY_COLUMNS);
  if (error || !data || data.length === 0) return null;
  return { row: data[0] as unknown as DeliveryRow, lease: { value: leaseUntil } };
}

/**
 * Extend the lease just before a platform call, compare-and-set on the value
 * this drain wrote. If the swap misses, the lease expired and another drain
 * took the row (or it was superseded): the caller must not send.
 */
async function renewLease(row: DeliveryRow, lease: Lease, clock: Clock): Promise<boolean> {
  const db = createAdminClient();
  const next = new Date(clock().getTime() + LEASE_MS).toISOString();
  const { data, error } = await db
    .from("integration_deliveries")
    .update({ locked_until: next })
    .eq("id", row.id)
    .eq("workspace_id", row.workspace_id)
    .in("status", ["pending", "retry"])
    .eq("locked_until", lease.value)
    .select("id");
  if (error || !data || data.length === 0) return false;
  lease.value = next;
  return true;
}

async function attemptDelivery(
  row: DeliveryRow,
  connector: ConnectorRow,
  secrets: LarkSecrets,
  ctx: { clock: Clock; lease: Lease },
): Promise<Attempt> {
  const adapter = await getAdapter(connector.kind);
  if (!adapter) return { kind: "failed", retryable: true, error: "Platform adapter is unavailable" };
  const secretList = [secrets.appSecret, secrets.verificationToken, secrets.encryptKey];
  const fail = (retryable: boolean, error: string): Attempt => ({ kind: "failed", retryable, error });
  /** Last gate before the wire: we still own the row. */
  const owns = () => renewLease(row, ctx.lease, ctx.clock);

  try {
    switch (row.kind) {
      case "approval_card": {
        const ev = row.payload.event as ApprovalEvent | undefined;
        if (!ev || !row.external_target) return fail(false, "Malformed approval card delivery");
        // Before a token exists and before anything leaves: a request that was
        // decided (or removed) since this card was queued gets no card at all,
        // and neither does one that was EDITED since the card's content was
        // captured (the replacement card carries the new content).
        const now = await readRequest(row);
        if (now.state !== "pending") {
          return { kind: "superseded", reason: now.state === "missing" ? "request no longer exists" : "request already decided" };
        }
        const versioned = !!row.approval_kind && isVersionedKind(row.approval_kind);
        // The card shows the event's content, so its token can only be bound to the
        // version THAT content came from. An event with no version (a legacy queued
        // row) is never bound to whatever version is current now: the card would
        // then carry live buttons for content it does not show.
        if (versioned && !ev.version) {
          return fail(false, "Approval event has no content version, so its card cannot be bound to what it shows");
        }
        if (versioned && now.version && !sameVersion(ev.version, now.version)) {
          return { kind: "superseded", reason: "request changed before delivery" };
        }
        const actionToken = await mintActionToken(row, versioned ? (ev.version ?? null) : null);
        const body = adapter.renderApprovalCard(ev, { actionToken, appUrl: appBaseUrl() });
        if (!(await owns())) return { kind: "lost" };
        return toAttempt(
          await adapter.send(connector, secrets, {
            receiveIdType: "open_id",
            receiveId: row.external_target,
            body,
            idempotencyKey: row.id,
          }),
          secretList,
        );
      }
      case "decision_update": {
        const ev = row.payload.event as ApprovalDecidedEvent | undefined;
        if (!ev || !row.parent_delivery_id) return fail(false, "Malformed decision update delivery");
        // A queued update for a retired approval kind (timesheets were removed; see approval_card via readRequest) has nothing to render.
        if (!REQUEST_SOURCES[ev.kind]) return { kind: "superseded", reason: "approval kind retired" };
        const parent = await loadParent(row);
        // Same patch machinery, two bodies: the request was decided, or it was
        // edited and a new card replaces this one.
        const body =
          row.payload.variant === "changed"
            ? adapter.renderChangedUpdate(ev, { appUrl: appBaseUrl() })
            : adapter.renderDecisionUpdate(ev, { appUrl: appBaseUrl() });
        if (!parent) return { kind: "superseded", reason: "card was never delivered" };
        if (parent.status === "superseded" || parent.status === "dead") {
          // A parent that was SENT at least once and then settled as superseded/dead without ever
          // recording a message id is ambiguous, not "never delivered": the send may have landed
          // with its response lost (timeout, dropped connection), and the retry that followed then
          // found the request already decided. The person may be holding a live card.
          // Only a parent that provably never left (zero attempts) lets the update be dropped.
          if (parent.attempts > 0 && !parent.external_message_id && parent.external_target) {
            return recoverAmbiguousParent(row, parent, body, { adapter, connector, secrets, secretList, owns });
          }
          return { kind: "superseded", reason: "card was never delivered" };
        }
        if (parent.status !== "sent" || !parent.external_message_id) {
          return { kind: "failed", retryable: true, error: "Card not delivered yet", waitingOnParent: true };
        }
        // The platform will not edit a card past its 14-day window: asking would only
        // dead-letter (and read as a failing delivery in the health view).
        if (parent.sent_at && ctx.clock().getTime() - Date.parse(parent.sent_at) > CARD_EDIT_WINDOW_MS) {
          return { kind: "superseded", reason: "card too old to edit" };
        }
        if (!(await owns())) return { kind: "lost" };
        const res = toAttempt(await adapter.update(connector, secrets, parent.external_message_id, body), secretList);
        return res.kind === "sent" ? { kind: "sent", externalMessageId: parent.external_message_id } : res;
      }
      case "digest": {
        const data = row.payload.data as DigestData | undefined;
        if (!data || !row.external_target) return fail(false, "Malformed digest delivery");
        const body = adapter.renderDigest(data);
        if (!(await owns())) return { kind: "lost" };
        return toAttempt(
          await adapter.send(connector, secrets, {
            receiveIdType: "chat_id",
            receiveId: row.external_target,
            body,
            idempotencyKey: row.id,
          }),
          secretList,
        );
      }
      case "bot_reply": {
        const body = row.payload.body as Record<string, unknown> | undefined;
        const receiveIdType = row.payload.receiveIdType === "chat_id" ? "chat_id" : "open_id";
        if (!body || !row.external_target) return fail(false, "Malformed bot reply delivery");
        if (!(await owns())) return { kind: "lost" };
        return toAttempt(
          await adapter.send(connector, secrets, {
            receiveIdType,
            receiveId: row.external_target,
            body,
            idempotencyKey: row.id,
          }),
          secretList,
        );
      }
      default:
        return fail(false, `Unknown delivery kind: ${String(row.kind)}`);
    }
  } catch (err) {
    return fail(true, sanitizeError(err, secretList));
  }
}

/**
 * The parent card's send was attempted but never recorded a message id, and the
 * card has since been superseded (or died). We cannot patch what we cannot
 * address, so resolve the message id the platform holds: re-send under the
 * PARENT's idempotency key (its delivery id, the key every attempt of that card
 * used). The platform deduplicates by that key for an hour:
 *  - the original DID land: the send returns the original message (live
 *    buttons); we then patch it to the decided body, exactly as for a normal card;
 *  - it did NOT land (or the window has passed): the send creates a message whose
 *    content is already the decided body, so the patch that follows is a no-op
 *    and the person is told the outcome rather than left with nothing.
 * Either way no card with live buttons is left behind. A refusal that no retry can
 * fix drops the update (the card is unreachable); a transient one retries it.
 */
async function recoverAmbiguousParent(
  row: DeliveryRow,
  parent: DeliveryRow,
  body: Record<string, unknown>,
  io: {
    adapter: ConnectorAdapter;
    connector: ConnectorRow;
    secrets: LarkSecrets;
    secretList: (string | null | undefined)[];
    owns: () => Promise<boolean>;
  },
): Promise<Attempt> {
  const { adapter, connector, secrets, secretList, owns } = io;
  if (!(await owns())) return { kind: "lost" };
  const sent = toAttempt(
    await adapter.send(connector, secrets, {
      receiveIdType: "open_id",
      receiveId: parent.external_target as string,
      body,
      idempotencyKey: parent.id,
    }),
    secretList,
  );
  if (sent.kind === "failed") {
    return sent.retryable ? sent : { kind: "superseded", reason: "card was never delivered" };
  }
  if (sent.kind !== "sent" || !sent.externalMessageId) {
    return { kind: "failed", retryable: true, error: "Platform returned no message id for the card" };
  }
  if (!(await owns())) return { kind: "lost" };
  const patched = toAttempt(await adapter.update(connector, secrets, sent.externalMessageId, body), secretList);
  return patched.kind === "sent" ? { kind: "sent", externalMessageId: sent.externalMessageId } : patched;
}

function toAttempt(
  res: Awaited<ReturnType<ConnectorAdapter["send"]>>,
  secretList: (string | null | undefined)[],
): Attempt {
  if (res.ok) return { kind: "sent", externalMessageId: res.externalMessageId };
  return { kind: "failed", retryable: res.retryable, error: sanitizeError(res.error, secretList) };
}

async function loadParent(row: DeliveryRow): Promise<DeliveryRow | null> {
  const db = createAdminClient();
  const { data } = await db
    .from("integration_deliveries")
    .select(DELIVERY_COLUMNS)
    .eq("id", row.parent_delivery_id as string)
    .eq("workspace_id", row.workspace_id)
    .maybeSingle();
  return (data as unknown as DeliveryRow | null) ?? null;
}

/** Persist the outcome of one attempt and release the lease. */
async function settle(row: DeliveryRow, attempt: Attempt, clock: Clock, summary: DrainSummary): Promise<void> {
  if (attempt.kind === "lost") return;
  const db = createAdminClient();
  const now = clock();
  const attemptsDone = row.attempts + 1;
  let patch: Record<string, unknown>;

  switch (attempt.kind) {
    case "sent":
      summary.sent += 1;
      patch = {
        status: "sent",
        attempts: attemptsDone,
        sent_at: now.toISOString(),
        external_message_id: attempt.externalMessageId,
        last_error: null,
        locked_until: null,
      };
      break;
    case "superseded":
      summary.superseded += 1;
      patch = { status: "superseded", locked_until: null, last_error: attempt.reason };
      break;
    case "deferred":
      summary.deferred += 1;
      patch = { locked_until: null };
      break;
    case "failed": {
      const plan = planAfterFailure(attemptsDone, attempt.retryable, now);
      if (plan.status === "retry") {
        summary.retried += 1;
        patch = {
          status: "retry",
          attempts: attemptsDone,
          next_attempt_at: plan.nextAttemptAt.toISOString(),
          last_error: attempt.error,
          locked_until: null,
        };
      } else {
        summary.dead += 1;
        patch = { status: "dead", attempts: attemptsDone, last_error: attempt.error, locked_until: null };
      }
      break;
    }
  }

  const { error } = await db
    .from("integration_deliveries")
    .update(patch)
    .eq("id", row.id)
    .eq("workspace_id", row.workspace_id);
  if (error) console.error("[integrations] failed to record delivery result:", sanitizeError(error));
}

// ── same-pass follow-ups ───────────────────────────────────────────────────

/**
 * Called when a platform hook should issue a fresh card for an approval whose
 * old card was just retired because the request was edited (see
 * `setChangedFollowUp`). Registered by emit.ts; deliveries cannot import it
 * (emit imports deliveries).
 */
export type ChangedFollowUp = (ev: ApprovalEvent) => Promise<void>;
let changedFollowUp: ChangedFollowUp | null = null;

export function setChangedFollowUp(fn: ChangedFollowUp | null): void {
  changedFollowUp = fn;
}

/**
 * The request was decided OR EDITED while this card's send was in flight, so
 * the fan-out for that event found a card with no message id yet and queued a
 * patch that could only wait. The send has now settled: kill any token that was
 * minted after that fan-out's kill pass (an edit's tokens are retired as
 * 'changed', so a late tap says so), then run the waiting patch immediately
 * instead of leaving live Approve/Reject buttons on the card until the next
 * drain (up to a day away). After an EDIT patch, the approver whose card was in
 * flight has no replacement yet (the unique queue index kept the new card out
 * while the old row was leased), so the follow-up issues it now.
 *
 * "Edited" = a `changed` patch is waiting on this card (the fan-out of an edit
 * already ran and could only queue it), or the token this card carries is bound
 * to a version the request is no longer at. If the fan-out has not queued its
 * patch yet, there is nothing to run: it will find this card already `sent` and
 * patch it itself.
 */
async function reconcileDecidedDuringSend(card: DeliveryRow, clock: Clock, summary: DrainSummary): Promise<void> {
  const db = createAdminClient();
  const now = await readRequest(card);

  // The patches queued against this card, read first: a waiting `changed` variant
  // is proof the card was retired by an edit, whatever version its token carries.
  const { data: queuedPatches, error: queuedError } = await db
    .from("integration_deliveries")
    .select("id, payload")
    .eq("workspace_id", card.workspace_id)
    .eq("kind", "decision_update")
    .eq("parent_delivery_id", card.id)
    .in("status", ["pending", "retry"]);
  if (queuedError) throw queuedError;
  const waiting = (queuedPatches ?? []) as { id: string; payload: Record<string, unknown> }[];

  let edited = now.state === "pending" && waiting.some((w) => w.payload?.variant === "changed");
  if (!edited && now.state === "pending" && now.version) {
    const { data: tokens, error: versionError } = await db
      .from("action_tokens")
      .select("approval_version")
      .eq("workspace_id", card.workspace_id)
      .eq("delivery_id", card.id);
    if (versionError) throw versionError;
    edited = ((tokens ?? []) as { approval_version: string | null }[]).some(
      (t) => t.approval_version !== null && !sameVersion(t.approval_version, now.version),
    );
  }
  if (now.state === "pending" && !edited) return;

  const nowIso = clock().toISOString();
  const { error: tokenError } = await db
    .from("action_tokens")
    .update({ used_at: nowIso, ...(edited ? { superseded_reason: "changed" } : {}) })
    .eq("workspace_id", card.workspace_id)
    .eq("delivery_id", card.id)
    .is("used_at", null);
  if (tokenError) throw tokenError;

  if (waiting.length === 0) return;

  await runNow(card.workspace_id, card.connector_id, waiting.map((r) => r.id), clock, summary);

  if (!changedFollowUp || now.state !== "pending") return;
  for (const patch of waiting) {
    if (patch.payload?.variant !== "changed" || !patch.payload.event) continue;
    try {
      await changedFollowUp(patch.payload.event as ApprovalEvent);
    } catch (err) {
      console.error("[integrations] follow-up card after an edit failed:", sanitizeError(err));
    }
  }
}

/**
 * A `decision_update` just failed with "Card not delivered yet". If its card
 * settled in the meantime (the send finished after the update looked), run the
 * update once more now. The mirror image of `reconcileDecidedDuringSend`: one
 * of the two always sees the other's write, so a settled card never waits for
 * a drain to learn it has been decided.
 */
async function retryUpdateIfCardSettled(update: DeliveryRow, clock: Clock, summary: DrainSummary): Promise<void> {
  const parent = await loadParent(update);
  if (parent && (parent.status === "pending" || parent.status === "retry")) return;
  await runNow(update.workspace_id, update.connector_id, [update.id], clock, summary);
}

/** Make the given rows due now and drain exactly them, without any further follow-up. */
async function runNow(
  workspaceId: string,
  connectorId: string,
  ids: string[],
  clock: Clock,
  summary: DrainSummary,
): Promise<void> {
  const db = createAdminClient();
  const now = clock();
  const { error } = await db
    .from("integration_deliveries")
    .update({ next_attempt_at: now.toISOString() })
    .eq("workspace_id", workspaceId)
    .in("id", ids)
    .in("status", ["pending", "retry"]);
  if (error) throw error;
  mergeDrain(summary, await drainOnce({ workspaceId, connectorId, ids, now }, false));
}
