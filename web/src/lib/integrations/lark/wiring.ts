/**
 * Production bindings for the Lark adapter's inbound side: the one file that
 * connects the transport-agnostic handlers (./handlers.ts, ./http.ts) to the
 * Integration Hub core (store, secrets, identity, inbound pipeline), Next's
 * `after()` and the database-backed rate limiter.
 *
 * Kept apart from ./index.ts on purpose: the hub core imports `larkAdapter`
 * from the index, so the index must not import the hub core back.
 */

import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPendingCounts } from "@/lib/governance/pending-counts";
import { consumeLinkCode, lookupIdentity } from "@/lib/integrations/identity";
import { handleApprovalAction } from "@/lib/integrations/inbound";
import { CONNECTOR_COLUMNS, appBaseUrl, loadConnectorSecrets, normalizeConfig } from "@/lib/integrations/store";
import type { ConnectorRow, LarkSecrets } from "@/lib/integrations/types";
import { normalizeAppUrl, resolveAppUrl } from "./cards";
import { sendCard } from "./client";
import type { LarkHandlerContext, LarkHandlerDeps, LogLevel, PendingApprovalsResult } from "./handlers";
import type { WebhookDeps } from "./http";

// ── logging ────────────────────────────────────────────────────────────────

/** Ids and reasons only: callers never pass tokens, codes, message text or secrets. */
function log(level: LogLevel, message: string, meta: Record<string, unknown> = {}): void {
  const line = `[nopm][lark] ${message}`;
  if (level === "error") console.error(line, meta);
  else if (level === "warn") console.warn(line, meta);
  else console.info(line, meta);
}

// ── event de-duplication ───────────────────────────────────────────────────

const CLAIM_TTL_MS = 60 * 60 * 1000;
const CLAIM_MAX_ENTRIES = 5000;
const claimed = new Map<string, number>();

/**
 * Best-effort, per-process "have I handled this event id?" for bot DMs. The
 * platform re-delivers an event (same `event_id`) when it did not get a 200 in
 * time; we answer immediately and work afterwards, so a retry is rare and,
 * when it does land on the same warm instance, is dropped here. Approval
 * clicks do NOT rely on this: they are made idempotent in the database
 * (`inbound_actions` unique on connector + event id) by the hub core.
 */
export function claimEventInMemory(connectorId: string, eventId: string, nowMs: number = Date.now()): boolean {
  if (claimed.size >= CLAIM_MAX_ENTRIES) {
    for (const [key, at] of claimed) if (nowMs - at > CLAIM_TTL_MS) claimed.delete(key);
    if (claimed.size >= CLAIM_MAX_ENTRIES) claimed.clear();
  }
  const key = `${connectorId}:${eventId}`;
  const seen = claimed.get(key);
  if (seen !== undefined && nowMs - seen <= CLAIM_TTL_MS) return false;
  claimed.set(key, nowMs);
  return true;
}

// ── background work ────────────────────────────────────────────────────────

/** Run after the HTTP response is sent (Vercel keeps the instance alive for it). */
function background(work: Promise<unknown>): void {
  try {
    after(() => work);
  } catch {
    // Not inside a request scope (script / test): the work is already running.
  }
}

// ── pending counts (the `approvals` bot command) ───────────────────────────

async function countPending(input: {
  connector: ConnectorRow;
  externalTenant: string;
  externalUserId: string;
}): Promise<PendingApprovalsResult> {
  try {
    const identity = await lookupIdentity(input.connector, input.externalTenant, input.externalUserId);
    if (!identity) return { status: "unlinked" };
    // Same audience as the approval cards (admins + managers).
    if (identity.role !== "admin" && identity.role !== "manager") return { status: "not_approver" };
    const counts = await getPendingCounts(createAdminClient(), {
      userId: identity.profileId,
      workspaceId: input.connector.workspace_id,
    });
    return { status: "ok", deletions: counts.approvals, changeRequests: counts.changeControl };
  } catch (err) {
    log("warn", "pending count failed", { connectorId: input.connector.id, error: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
    return { status: "error" };
  }
}

// ── contexts ───────────────────────────────────────────────────────────────

export function productionDeps(): LarkHandlerDeps {
  return {
    handleApprovalAction,
    consumeLinkCode,
    countPending,
    claimEvent: async (connectorId, eventId) => claimEventInMemory(connectorId, eventId),
    send: (connector, secrets, msg) => sendCard(connector, secrets, msg),
    now: () => new Date(),
    log,
  };
}

/**
 * Handler context + dependencies for a connector. `requestOrigin` is the origin
 * the platform called (used for deep links only when NEXT_PUBLIC_APP_URL is not
 * configured); the relay passes nothing and falls back to env. Pass `secrets`
 * when the caller already decrypted them.
 */
export function productionContext(
  connector: ConnectorRow,
  requestOrigin?: string | null,
  secrets: LarkSecrets = loadConnectorSecrets(connector),
): { ctx: LarkHandlerContext; deps: LarkHandlerDeps } {
  const appUrl = normalizeAppUrl(appBaseUrl(requestOrigin)) || resolveAppUrl();
  return { ctx: { connector, secrets, appUrl, background }, deps: productionDeps() };
}

// ── webhook route dependencies ─────────────────────────────────────────────

/**
 * Connector by id alone: the webhook URL carries the connector uuid and nothing
 * else, so there is no workspace to filter by yet. The id is an unguessable
 * uuid and the row IS the workspace binding for everything downstream.
 */
async function loadConnector(connectorId: string): Promise<ConnectorRow | null> {
  const { data, error } = await createAdminClient()
    .from("integration_connectors")
    .select(CONNECTOR_COLUMNS)
    .eq("id", connectorId)
    .eq("kind", "lark")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as unknown as ConnectorRow;
  // `config` is free-form jsonb: never trust its shape.
  return { ...row, config: normalizeConfig(row.config) };
}

const RATE_WINDOW_SECONDS = 60;

/**
 * Same mechanism as src/lib/api/rate-limit.ts: the `nopm_rate_check` RPC, a
 * row-locked fixed window that holds across serverless instances. Fail-OPEN on
 * infrastructure errors (an abuse guard, not an auth control), loudly.
 */
async function rateCheck(key: string, max: number): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const { data, error } = await createAdminClient().rpc("nopm_rate_check", {
    p_key: key,
    p_max: max,
    p_window_seconds: RATE_WINDOW_SECONDS,
  });
  if (error) {
    console.error("[nopm][lark] nopm_rate_check RPC failed - FAILING OPEN (cap not enforced this call)", { key, error: error.message });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  const result = data as { allowed: boolean; retry_after_seconds: number };
  return { allowed: result.allowed, retryAfterSeconds: result.retry_after_seconds };
}

export function productionWebhookDeps(): WebhookDeps {
  return {
    loadConnector,
    readSecrets: loadConnectorSecrets,
    rateCheck,
    buildContext: (connector, secrets, requestOrigin) => productionContext(connector, requestOrigin, secrets),
    now: Date.now,
    log,
  };
}
