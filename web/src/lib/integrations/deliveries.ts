import { createAdminClient } from "@/lib/supabase/admin";
import { generateToken } from "@/lib/auth/tokens";
import { sanitizeError } from "@/lib/integrations/secrets";
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
 *    (`where status in (pending, retry) and lease is free`). Postgres
 *    re-evaluates the WHERE after waiting on a concurrent writer, so two
 *    drains (an `after()` run racing the daily cron) can never both claim the
 *    same row. A drain killed mid-send simply lets its lease expire.
 *  - Failures retry on 1m, 5m, 30m, 2h, 12h, then the row goes `dead`. A
 *    non-retryable adapter result (bad credentials, invalid target) goes dead
 *    immediately. `last_error` is sanitised + truncated: never a secret,
 *    never a message body.
 *  - The raw action token a card carries is minted at SEND time and lives
 *    only in the card; the table stores its SHA-256. A retry mints a fresh
 *    token (a card that did reach the user keeps working until it is used,
 *    superseded by a decision, or expires after 7 days).
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
export const ACTION_TOKEN_PREFIX = "npa_";
export const DEFAULT_DRAIN_LIMIT = 25;

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
};

/** Queue deliveries (status pending, due now). Returns the inserted rows. */
export async function insertDeliveries(
  workspaceId: string,
  connectorId: string,
  rows: NewDelivery[],
): Promise<DeliveryRow[]> {
  if (rows.length === 0) return [];
  const db = createAdminClient();
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
      })),
    )
    .select(DELIVERY_COLUMNS);
  if (error) throw new Error(`Failed to queue deliveries: ${error.message}`);
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
 * "send now" never suppresses the scheduled one.
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

// ── action tokens ──────────────────────────────────────────────────────────

/**
 * Mint the single-use token a card carries. Bound to ONE recipient and ONE
 * approval; only its SHA-256 is stored. Returns the raw value, which must go
 * straight into the card and nowhere else (never logged, never persisted).
 */
async function mintActionToken(row: DeliveryRow): Promise<string> {
  if (!row.recipient_profile_id || !row.approval_kind || !row.approval_id) {
    throw new Error("Approval card delivery is missing its recipient or approval reference");
  }
  const { raw, hash } = generateToken(ACTION_TOKEN_PREFIX);
  const db = createAdminClient();
  const { error } = await db.from("action_tokens").insert({
    workspace_id: row.workspace_id,
    delivery_id: row.id,
    recipient_profile_id: row.recipient_profile_id,
    approval_kind: row.approval_kind,
    approval_id: row.approval_id,
    token_hash: hash,
    expires_at: new Date(Date.now() + ACTION_TOKEN_TTL_MS).toISOString(),
  });
  if (error) throw new Error(`Failed to mint action token: ${error.message}`);
  return raw;
}

// ── drain ──────────────────────────────────────────────────────────────────

/** How many due retries an event-triggered drain will also pick up. */
export const OPPORTUNISTIC_RETRY_BATCH = 10;

export type DrainOptions = {
  /** Required: every drain is scoped to one workspace. */
  workspaceId: string;
  connectorId?: string;
  /** Restrict to these delivery ids (the rows an emit just queued). */
  ids?: string[];
  limit?: number;
  now?: Date;
};

export type DrainSummary = {
  claimed: number;
  sent: number;
  retried: number;
  dead: number;
  superseded: number;
  /** Released unsent (connector paused). */
  deferred: number;
};

type Attempt =
  | { kind: "sent"; externalMessageId: string | null }
  | { kind: "failed"; retryable: boolean; error: string }
  | { kind: "superseded"; reason: string }
  | { kind: "deferred" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = any;

export async function drainDeliveries(opts: DrainOptions): Promise<DrainSummary> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const summary: DrainSummary = { claimed: 0, sent: 0, retried: 0, dead: 0, superseded: 0, deferred: 0 };
  const db = createAdminClient();

  let query: Q = db
    .from("integration_deliveries")
    .select(DELIVERY_COLUMNS)
    .eq("workspace_id", opts.workspaceId)
    .in("status", ["pending", "retry"])
    .lte("next_attempt_at", nowIso)
    .or(`locked_until.is.null,locked_until.lte.${nowIso}`)
    .order("next_attempt_at", { ascending: true })
    .limit(opts.limit ?? DEFAULT_DRAIN_LIMIT);
  if (opts.connectorId) query = query.eq("connector_id", opts.connectorId);
  if (opts.ids) query = query.in("id", opts.ids);

  const { data: candidates, error } = await query;
  if (error) {
    console.error("[integrations] drain select failed:", sanitizeError(error));
    return summary;
  }

  const connectors = new Map<string, ConnectorRow | null>();
  const loadConnector = async (row: DeliveryRow): Promise<ConnectorRow | null> => {
    if (!connectors.has(row.connector_id)) {
      connectors.set(row.connector_id, await getConnector(row.workspace_id, row.connector_id));
    }
    return connectors.get(row.connector_id) ?? null;
  };

  for (const candidate of (candidates ?? []) as unknown as DeliveryRow[]) {
    const row = await claim(candidate, now);
    if (!row) continue; // another drain owns it
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
          ? await attemptDelivery(row, connector, secrets)
          : { kind: "failed", retryable: true, error: "Connector secrets are unreadable (check the encryption key)" };
      }
    } catch (err) {
      attempt = {
        kind: "failed",
        retryable: true,
        error: sanitizeError(err, [secrets?.appSecret, secrets?.verificationToken, secrets?.encryptKey]),
      };
    }

    await settle(row, attempt, now, summary);
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

/** Claim one row with a lease. Null when someone else holds it or it is no longer due. */
async function claim(row: DeliveryRow, now: Date): Promise<DeliveryRow | null> {
  const db = createAdminClient();
  const nowIso = now.toISOString();
  const { data, error } = await db
    .from("integration_deliveries")
    .update({ locked_until: new Date(now.getTime() + LEASE_MS).toISOString() })
    .eq("id", row.id)
    .eq("workspace_id", row.workspace_id)
    .in("status", ["pending", "retry"])
    .or(`locked_until.is.null,locked_until.lte.${nowIso}`)
    .select(DELIVERY_COLUMNS);
  if (error || !data || data.length === 0) return null;
  return data[0] as unknown as DeliveryRow;
}

async function attemptDelivery(row: DeliveryRow, connector: ConnectorRow, secrets: LarkSecrets): Promise<Attempt> {
  const adapter = await getAdapter(connector.kind);
  if (!adapter) return { kind: "failed", retryable: true, error: "Platform adapter is unavailable" };
  const secretList = [secrets.appSecret, secrets.verificationToken, secrets.encryptKey];
  const fail = (retryable: boolean, error: string): Attempt => ({ kind: "failed", retryable, error });

  try {
    switch (row.kind) {
      case "approval_card": {
        const ev = row.payload.event as ApprovalEvent | undefined;
        if (!ev || !row.external_target) return fail(false, "Malformed approval card delivery");
        const actionToken = await mintActionToken(row);
        const body = adapter.renderApprovalCard(ev, { actionToken, appUrl: appBaseUrl() });
        return toAttempt(
          await adapter.send(connector, secrets, { receiveIdType: "open_id", receiveId: row.external_target, body }),
          secretList,
        );
      }
      case "decision_update": {
        const ev = row.payload.event as ApprovalDecidedEvent | undefined;
        if (!ev || !row.parent_delivery_id) return fail(false, "Malformed decision update delivery");
        const parent = await loadParent(row);
        if (!parent || parent.status === "superseded" || parent.status === "dead") {
          return { kind: "superseded", reason: "card was never delivered" };
        }
        if (parent.status !== "sent" || !parent.external_message_id) {
          return fail(true, "Card not delivered yet");
        }
        const body = adapter.renderDecisionUpdate(ev, { appUrl: appBaseUrl() });
        const res = toAttempt(await adapter.update(connector, secrets, parent.external_message_id, body), secretList);
        return res.kind === "sent" ? { kind: "sent", externalMessageId: parent.external_message_id } : res;
      }
      case "digest": {
        const data = row.payload.data as DigestData | undefined;
        if (!data || !row.external_target) return fail(false, "Malformed digest delivery");
        const body = adapter.renderDigest(data);
        return toAttempt(
          await adapter.send(connector, secrets, { receiveIdType: "chat_id", receiveId: row.external_target, body }),
          secretList,
        );
      }
      case "bot_reply": {
        const body = row.payload.body as Record<string, unknown> | undefined;
        const receiveIdType = row.payload.receiveIdType === "chat_id" ? "chat_id" : "open_id";
        if (!body || !row.external_target) return fail(false, "Malformed bot reply delivery");
        return toAttempt(
          await adapter.send(connector, secrets, { receiveIdType, receiveId: row.external_target, body }),
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
async function settle(row: DeliveryRow, attempt: Attempt, now: Date, summary: DrainSummary): Promise<void> {
  const db = createAdminClient();
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
