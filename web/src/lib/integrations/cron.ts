import { createHash, timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import type { Actor } from "@/lib/auth/guard";
import { drainDeliveries, enqueueDigest, type DrainSummary } from "@/lib/integrations/deliveries";
import { gatherDigestData } from "@/lib/integrations/digest-data";
import { sanitizeError } from "@/lib/integrations/secrets";
import { CONNECTOR_COLUMNS, normalizeConfig } from "@/lib/integrations/store";
import type { ConnectorRow } from "@/lib/integrations/types";

/**
 * The daily scheduler tick (Vercel Cron, D6): retry deliveries that are due
 * and send each connector's weekly digest on its configured weekday.
 *
 * It is a SYSTEM job: it enumerates active connectors across workspaces once,
 * then every other query is scoped to that connector's workspace. Paused and
 * revoked connectors are skipped entirely (the kill switch stops both
 * directions), so their queued rows stay untouched until resumed.
 */

/**
 * Constant-time check of `Authorization: Bearer <CRON_SECRET>`. Fails CLOSED:
 * an unset/empty CRON_SECRET authorises nobody (a missing env var must never
 * turn the cron endpoint into a public trigger).
 */
export function verifyCronAuth(authorization: string | null, secret: string | undefined = process.env.CRON_SECRET): boolean {
  if (!secret || !authorization) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return false;
  const a = createHash("sha256").update(match[1]).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

/** Monday 00:00 UTC of the ISO week containing `d`. */
export function isoWeekStart(d: Date): Date {
  const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // Mon=1 … Sun=7
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (day - 1)));
}

export type CronSummary = {
  connectors: number;
  deliveries: DrainSummary;
  digests: { sent: number; skipped: number; failed: number };
};

const EMPTY_DRAIN: DrainSummary = { claimed: 0, sent: 0, retried: 0, dead: 0, superseded: 0, deferred: 0 };
const CRON_DRAIN_LIMIT = 50;

export async function runCron(opts: { now?: Date } = {}): Promise<CronSummary> {
  const now = opts.now ?? new Date();
  const db = createAdminClient();
  const summary: CronSummary = {
    connectors: 0,
    deliveries: { ...EMPTY_DRAIN },
    digests: { sent: 0, skipped: 0, failed: 0 },
  };

  const { data, error } = await db
    .from("integration_connectors")
    .select(CONNECTOR_COLUMNS)
    .eq("kind", "lark")
    .eq("status", "active");
  if (error) throw error;
  const connectors = ((data ?? []) as Record<string, unknown>[]).map(
    (r) => ({ ...(r as unknown as ConnectorRow), config: normalizeConfig(r.config) }),
  );

  for (const connector of connectors) {
    summary.connectors += 1;
    try {
      const drained = await drainDeliveries({
        workspaceId: connector.workspace_id,
        connectorId: connector.id,
        limit: CRON_DRAIN_LIMIT,
        now,
      });
      for (const k of Object.keys(EMPTY_DRAIN) as (keyof DrainSummary)[]) summary.deliveries[k] += drained[k];

      const outcome = await sendWeeklyDigestIfDue(connector, now);
      summary.digests[outcome] += 1;
    } catch (err) {
      // One connector's failure must not starve the others.
      console.error("[integrations] cron tick failed for a connector:", sanitizeError(err));
      summary.digests.failed += 1;
    }
  }
  return summary;
}

/**
 * Queue + send this connector's digest when today is its configured weekday
 * (UTC) and no scheduled digest has been queued yet this ISO week. A missed
 * day is not made up later: enabling the digest midweek must not fire it
 * immediately. Manual "send now" digests are tagged `trigger: manual` and do
 * not count against the weekly slot.
 */
export async function sendWeeklyDigestIfDue(
  connector: ConnectorRow,
  now: Date,
): Promise<"sent" | "skipped" | "failed"> {
  const { digest } = normalizeConfig(connector.config);
  if (!digest.enabled || !digest.chatId || digest.weekday !== now.getUTCDay()) return "skipped";

  const db = createAdminClient();
  const { data: already, error } = await db
    .from("integration_deliveries")
    .select("id")
    .eq("workspace_id", connector.workspace_id)
    .eq("connector_id", connector.id)
    .eq("kind", "digest")
    .eq("payload->>trigger", "scheduled")
    .gte("created_at", isoWeekStart(now).toISOString())
    .neq("status", "superseded")
    .limit(1);
  if (error) throw error;
  if ((already ?? []).length > 0) return "skipped";

  const data = await gatherDigestData(connector.workspace_id, { now });

  // Egress of workspace data to a third party is audited BEFORE it is queued,
  // so there is never an unaudited digest. The scheduler has no human actor:
  // it is recorded as the connector itself (actor_type 'token', id = connector).
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
    after: { trigger: "scheduled", chat_id: digest.chatId, week_start: isoWeekStart(now).toISOString().slice(0, 10) },
  });

  const queued = await enqueueDigest(connector, digest.chatId, data, "scheduled");
  if (!queued) return "failed";
  const result = await drainDeliveries({
    workspaceId: connector.workspace_id,
    connectorId: connector.id,
    ids: [queued.id],
    now,
  });
  return result.sent > 0 ? "sent" : "failed";
}
