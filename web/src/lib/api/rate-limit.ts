import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Actor } from "@/lib/auth/guard";
import { writeAudit } from "@/lib/audit/write";
import { RateLimitError } from "@/lib/api/errors";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const WINDOW_SECONDS = 60;

const READ_LIMIT = Number(process.env.NOPM_RATE_READ_PER_MIN ?? 600);
const WRITE_LIMIT = Number(process.env.NOPM_RATE_WRITE_PER_MIN ?? 120);

type RateCheckResult = {
  allowed: boolean;
  remaining: number;
  retry_after_seconds: number;
};

/**
 * Baseline DB-backed rate limit — workspace-keyed, per actor class (user vs
 * token), per read/write bucket. Fixed 60s window via the nopm_rate_check
 * RPC (row-locked fixed-window counter, mirrors nopm_demo_rate_check).
 *
 * Fail-OPEN on infra error (RPC unreachable / errors): this is a baseline
 * abuse guard, not an auth control — a rate-limiter outage must never take
 * the API down. Logged loudly so the outage is observable.
 *
 * Fail-CLOSED on an actual limit hit: throws RateLimitError (429). The
 * blocked-attempt audit row is fail-soft (try/catch) — audit-log flakiness
 * must never distort the 429 the caller already earned.
 */
export async function checkRateLimit(
  db: ReturnType<typeof createAdminClient>,
  actor: Actor,
  request: NextRequest,
): Promise<void> {
  const isWrite = !READ_METHODS.has(request.method.toUpperCase());
  const bucket = isWrite ? "write" : "read";
  const max = isWrite ? WRITE_LIMIT : READ_LIMIT;
  const key = `${actor.workspaceId}:${actor.type}:${bucket}`;

  const { data, error } = await db.rpc("nopm_rate_check", {
    p_key: key,
    p_max: max,
    p_window_seconds: WINDOW_SECONDS,
  });

  if (error) {
    // Fail-open (best-effort abuse protection, not an auth control) — but
    // make the failure LOUD in server logs so a cap that's silently not
    // enforcing shows up as an anomaly, not a mystery.
    console.error(
      "[nopm][rate-limit] nopm_rate_check RPC failed — FAILING OPEN (cap not enforced this call)",
      { key, rpc: "nopm_rate_check", error: error.message, at: new Date().toISOString() },
    );
    return;
  }

  const result = data as RateCheckResult;
  if (!result.allowed) {
    try {
      await writeAudit({
        workspaceId: actor.workspaceId,
        actor,
        action: "rate.limited",
        targetType: "rate_limit",
        // audit_log.target_id is a uuid column — the composite rate key would
        // fail the insert (silently, since this write is fail-soft), so it
        // travels in the payload instead.
        targetId: null,
        after: { key, bucket, max, window_seconds: WINDOW_SECONDS, retry_after_seconds: result.retry_after_seconds },
      });
    } catch (auditError) {
      // Fail-soft: a blocked-attempt audit row is best-effort observability,
      // not a governance guarantee (contrast: writeAudit on real mutations is
      // fail-closed). Never let an audit-write hiccup swallow the 429.
      console.error("[nopm][rate-limit] fail-soft audit write for rate.limited failed:", auditError);
    }
    throw new RateLimitError(
      `Rate limit exceeded for ${bucket} requests. Retry in ${result.retry_after_seconds}s.`,
    );
  }
}
