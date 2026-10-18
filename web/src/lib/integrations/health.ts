import { createAdminClient } from "@/lib/supabase/admin";
import type { CronRunView } from "@/lib/integrations/cron";
import { sanitizeError } from "@/lib/integrations/secrets";

/**
 * Operator visibility for one connector, shown on the ADMIN connector view.
 *
 * Delivery is best-effort by design, so a failing integration is silent unless
 * something surfaces it: a dead letter (a card that never reached anyone), a
 * queue that is not draining, a scheduler that never ran. Counts and
 * timestamps only: `last_error` is the already-sanitised, truncated text the
 * queue stored (never a secret or a message body).
 */
export type ConnectorHealth = {
  /** Queued and never attempted yet. */
  pending: number;
  /** Failed at least once and waiting for its next attempt. */
  retry: number;
  /** Gave up (dead letters). Pruned after the retention window. */
  dead: number;
  /** When the most recent message went out, or null if none has. */
  last_sent_at: string | null;
  /** Why the most recent failing delivery failed (sanitised, at most 300 characters). */
  last_error: string | null;
  /** When the scheduler last processed this connector, or null if it never has. */
  last_cron_at: string | null;
  /** Counts from that scheduler run. */
  last_cron: CronRunView | null;
};

/**
 * Null when the lookup itself failed: "unknown" must never read as "0 dead".
 */
export async function getConnectorHealth(workspaceId: string, connectorId: string): Promise<ConnectorHealth | null> {
  const db = createAdminClient();
  const scoped = () => db.from("integration_deliveries").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).eq("connector_id", connectorId);
  const count = async (status: string): Promise<number> => {
    const { count: n, error } = await scoped().eq("status", status);
    if (error) throw error;
    return n ?? 0;
  };

  try {
    const [pending, retry, dead, sent, failed, cron] = await Promise.all([
      count("pending"),
      count("retry"),
      count("dead"),
      db
        .from("integration_deliveries")
        .select("sent_at")
        .eq("workspace_id", workspaceId)
        .eq("connector_id", connectorId)
        .eq("status", "sent")
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from("integration_deliveries")
        .select("last_error")
        .eq("workspace_id", workspaceId)
        .eq("connector_id", connectorId)
        .in("status", ["retry", "dead"])
        .not("last_error", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from("integration_cron_state")
        .select("last_run_at, last_summary")
        .eq("workspace_id", workspaceId)
        .eq("connector_id", connectorId)
        .maybeSingle(),
    ]);
    for (const r of [sent, failed]) if (r.error) throw r.error;
    // The scheduler record is the one optional part: a database that has not applied migration 0051
    // yet has no such table, and the queue counts above are still worth showing.
    if (cron.error) console.error("[integrations] cron state unavailable:", sanitizeError(cron.error));
    const state = (cron.error ? null : cron.data) as { last_run_at: string; last_summary: CronRunView | null } | null;
    return {
      pending,
      retry,
      dead,
      last_sent_at: (sent.data as { sent_at: string | null } | null)?.sent_at ?? null,
      last_error: (failed.data as { last_error: string | null } | null)?.last_error ?? null,
      last_cron_at: state?.last_run_at ?? null,
      last_cron: state?.last_summary ?? null,
    };
  } catch (err) {
    // The connector list must still load when the health lookup does not.
    console.error("[integrations] connector health lookup failed:", sanitizeError(err));
    return null;
  }
}
