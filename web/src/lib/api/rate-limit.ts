import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Actor } from "@/lib/auth/guard";
import { writeAudit } from "@/lib/audit/write";
import { RateLimitError } from "@/lib/api/errors";

/**
 * The client address / network the PRE-AUTH, IP-keyed limiters may key on —
 * re-exported here so every limiter finds it next to checkRateLimit.
 *
 *  - `trustedClientIp(headers)`: the validated client IP, or null when none can
 *    be trusted. Never the caller-written first X-Forwarded-For entry (see
 *    @/lib/api/client-ip for the Vercel / NOPM_TRUSTED_PROXY_HOPS rule).
 *  - `ipRateKey(headers)`: the same, with IPv6 collapsed to its /64. USE THIS
 *    to build a rate-limit key (`my-limiter:${ipRateKey(h)}`) so one client
 *    cannot mint unlimited buckets and counter rows by rotating addresses
 *    inside its own network. When it returns null, either skip the IP cap or
 *    share one conservative bucket — do not invent a key from header text.
 */
export { clientIp as trustedClientIp, ipRateKey } from "@/lib/api/client-ip";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const WINDOW_SECONDS = 60;

/** Per-ACTOR budget (one token / one signed-in user). */
const READ_LIMIT = Number(process.env.NOPM_RATE_READ_PER_MIN ?? 600);
const WRITE_LIMIT = Number(process.env.NOPM_RATE_WRITE_PER_MIN ?? 120);
/**
 * Workspace-wide ceiling per actor class, kept above the per-actor budget so one
 * runaway token exhausts its OWN bucket first and cannot starve the others
 * (D-ACC-12 / A1-9), while many actors together still cannot flood a workspace.
 */
const WS_READ_LIMIT = Number(process.env.NOPM_RATE_WS_READ_PER_MIN ?? READ_LIMIT * 5);
const WS_WRITE_LIMIT = Number(process.env.NOPM_RATE_WS_WRITE_PER_MIN ?? WRITE_LIMIT * 5);

type RateCheckResult = {
  allowed: boolean;
  remaining: number;
  retry_after_seconds: number;
};

/**
 * Baseline DB-backed rate limit — two fixed 60s windows via the
 * nopm_rate_check RPC (row-locked fixed-window counter):
 *  1. per ACTOR (token id / user id) and read|write bucket, so one runaway
 *     token cannot starve the rest;
 *  2. per workspace and actor class and read|write bucket (the original
 *     ceiling, now set higher than the per-actor budget).
 *
 * Fail-OPEN on infra error (RPC unreachable / errors): this is a baseline
 * abuse guard, not an auth control — a rate-limiter outage must never take
 * the API down. Logged loudly so the outage is observable.
 *
 * Fail-CLOSED on an actual limit hit: throws RateLimitError (429, with the
 * window's retry-after). The blocked-attempt audit row is fail-soft and is
 * written AT MOST ONCE per actor per window (A3-7): a flooding client used to
 * add one permanent audit row per refused request.
 */
export async function checkRateLimit(
  db: ReturnType<typeof createAdminClient>,
  actor: Actor,
  request: NextRequest,
): Promise<void> {
  const isWrite = !READ_METHODS.has(request.method.toUpperCase());
  const bucket = isWrite ? "write" : "read";
  const actorKey = `${actor.workspaceId}:${actor.type}:${actor.id}:${bucket}`;
  const wsKey = `${actor.workspaceId}:${actor.type}:${bucket}`;

  const checks: { key: string; max: number; scope: "actor" | "workspace" }[] = [
    { key: actorKey, max: isWrite ? WRITE_LIMIT : READ_LIMIT, scope: "actor" },
    { key: wsKey, max: isWrite ? WS_WRITE_LIMIT : WS_READ_LIMIT, scope: "workspace" },
  ];

  for (const check of checks) {
    const { data, error } = await db.rpc("nopm_rate_check", {
      p_key: check.key,
      p_max: check.max,
      p_window_seconds: WINDOW_SECONDS,
    });

    if (error) {
      // Fail-open (best-effort abuse protection, not an auth control) — but
      // make the failure LOUD in server logs so a cap that's silently not
      // enforcing shows up as an anomaly, not a mystery.
      console.error(
        "[nopm][rate-limit] nopm_rate_check RPC failed — FAILING OPEN (cap not enforced this call)",
        { key: check.key, rpc: "nopm_rate_check", error: error.message, at: new Date().toISOString() },
      );
      return;
    }

    const result = data as RateCheckResult;
    if (!result.allowed) {
      await auditOncePerWindow(db, actor, {
        key: check.key,
        bucket,
        scope: check.scope,
        max: check.max,
        retry_after_seconds: result.retry_after_seconds,
      });
      throw new RateLimitError(
        `Rate limit exceeded for ${bucket} requests. Retry in ${result.retry_after_seconds}s.`,
        "rate_limited",
        result.retry_after_seconds,
      );
    }
  }
}

/**
 * One `rate.limited` audit row per actor per bucket per window, however many
 * requests are refused. The "have I already recorded this window" marker is a
 * second nopm_rate_check counter (cap 1, same window): only the first caller in
 * the window is told allowed. Fail-soft end to end — a blocked-attempt audit
 * row is best-effort observability, not a governance guarantee (contrast:
 * writeAudit on real mutations is fail-closed), and must never swallow the 429.
 */
async function auditOncePerWindow(
  db: ReturnType<typeof createAdminClient>,
  actor: Actor,
  detail: { key: string; bucket: string; scope: string; max: number; retry_after_seconds: number },
): Promise<void> {
  try {
    const { data, error } = await db.rpc("nopm_rate_check", {
      p_key: `rate-limited-audit:${actor.workspaceId}:${actor.id}:${detail.bucket}`,
      p_max: 1,
      p_window_seconds: WINDOW_SECONDS,
    });
    // On a marker error, stay silent rather than risk the unbounded stream.
    if (error || !(data as RateCheckResult | null)?.allowed) return;
    await writeAudit({
      workspaceId: actor.workspaceId,
      actor,
      action: "rate.limited",
      targetType: "rate_limit",
      // audit_log.target_id is a uuid column — the composite rate key would
      // fail the insert, so it travels in the payload instead.
      targetId: null,
      after: { ...detail, window_seconds: WINDOW_SECONDS },
    });
  } catch (auditError) {
    console.error("[nopm][rate-limit] fail-soft audit write for rate.limited failed:", auditError);
  }
}
