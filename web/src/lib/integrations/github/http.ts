/**
 * The public GitHub webhook flow (R-153): `POST /api/integrations/github/[connectorId]/events`.
 *
 *   uuid check -> capped raw body -> connector lookup (active only) -> decrypt secret ->
 *   HMAC-SHA256 `X-Hub-Signature-256` (constant time) -> per-connector rate limit ->
 *   event dispatch (`ping` / `pull_request` / `deployment_status`) -> record + apply -> 200.
 *
 * Ordering is the Lark webhook's: everything unauthenticated is one generic 401 (an unknown, paused or
 * revoked connector and every signature failure look the same, and a decoy secret is verified when the
 * connector is missing so a miss costs about what a hit does); failed attempts are counted in their own
 * small buckets; the real budget is charged only after authentication. Once a delivery is authentic and
 * recorded the answer is always 200 with a fixed tiny body: GitHub learns nothing about tasks, projects
 * or errors. A delivery already recorded (the same `X-GitHub-Delivery`) is a 200 that changes nothing.
 *
 * All I/O arrives through `GithubWebhookDeps` so this file is testable without Supabase.
 */

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ipRateKey } from "@/lib/api/client-ip";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { readCappedBody } from "@/lib/integrations/body";
import { decryptWebhookSecret } from "./secrets";
import { getGithubConnectorById, type GithubConnectorRow } from "./store";
import { processGithubDelivery } from "./process";
import { verifyGithubSignature } from "./verify";

export const GITHUB_MAX_BODY_BYTES = 1024 * 1024;
const DECOY_SECRET = "decoy-secret-for-constant-cost";
export const GITHUB_RATE_MAX = Number(process.env.NOPM_RATE_GITHUB_PER_MIN ?? 300);
export const GITHUB_BAD_ATTEMPTS_MAX = 30;
export const GITHUB_BAD_IP_MAX = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DELIVERY_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const NO_STORE = { "Cache-Control": "no-store" } as const;

export type GithubWebhookDeps = {
  db: SupabaseClient;
  loadConnector(db: SupabaseClient, id: string): Promise<GithubConnectorRow | null>;
  readSecret(connector: GithubConnectorRow): string;
  rateCheck(key: string, max: number): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  ipKey?(headers: Headers): string | null;
  log(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>): void;
};

function json(body: unknown, status: number, extra: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...extra } });
}
const unauthorized = () => json({ error: "unauthorized" }, 401);

export async function handleGithubWebhook(
  request: Request,
  connectorId: string,
  deps: GithubWebhookDeps,
): Promise<NextResponse> {
  if (!UUID_RE.test(connectorId)) return json({ error: "not_found" }, 404);

  const body = await readCappedBody(request, GITHUB_MAX_BODY_BYTES);
  if (!body.ok) return json({ error: "payload_too_large" }, 413);

  let connector: GithubConnectorRow | null = null;
  try {
    connector = await deps.loadConnector(deps.db, connectorId);
  } catch (e) {
    deps.log("error", "connector lookup failed", { error: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
    return json({ error: "unavailable" }, 503);
  }

  const live = connector && connector.status === "active" ? connector : null;
  let secret = DECOY_SECRET;
  if (live) {
    try {
      secret = deps.readSecret(live);
    } catch {
      // An active connector that cannot decrypt its own secret is an operator fault, not an attacker's signal.
      deps.log("error", "connector secret unreadable", { connector: live.id });
      return json({ error: "unavailable" }, 503);
    }
  }

  const signature = request.headers.get("x-hub-signature-256");
  const valid = verifyGithubSignature(body.text, signature, secret);
  if (!live || !valid) {
    deps.log("warn", "rejected delivery", { connector: connectorId, reason: !live ? "no_live_connector" : signature ? "bad_signature" : "missing_signature" });
    const perConnector = await deps.rateCheck(`github-bad:${connectorId}`, GITHUB_BAD_ATTEMPTS_MAX);
    const ip = deps.ipKey?.(request.headers) ?? null;
    const perIp = ip ? await deps.rateCheck(`github-bad-ip:${ip}`, GITHUB_BAD_IP_MAX) : { allowed: true, retryAfterSeconds: 0 };
    if (!perConnector.allowed || !perIp.allowed) {
      return json({ error: "rate_limited" }, 429, {
        "Retry-After": String(Math.max(perConnector.retryAfterSeconds, perIp.retryAfterSeconds, 1)),
      });
    }
    return unauthorized();
  }

  const budget = await deps.rateCheck(`github-wh:${live.id}`, GITHUB_RATE_MAX);
  if (!budget.allowed) return json({ error: "rate_limited" }, 429, { "Retry-After": String(Math.max(budget.retryAfterSeconds, 1)) });

  const eventName = request.headers.get("x-github-event") ?? "";
  if (eventName === "ping") return json({ ok: true }, 200);
  if (eventName !== "pull_request" && eventName !== "deployment_status") return json({ ok: true }, 200);

  const deliveryId = request.headers.get("x-github-delivery") ?? "";
  if (!DELIVERY_ID_RE.test(deliveryId)) return json({ error: "bad_request" }, 400);

  let payload: unknown;
  try {
    payload = JSON.parse(body.text);
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  try {
    await processGithubDelivery({
      db: deps.db,
      connector: { id: live.id, workspace_id: live.workspace_id, name: live.name },
      deliveryId,
      eventName,
      payload,
      bodyHash: createHash("sha256").update(body.text, "utf8").digest("hex"),
    });
  } catch (e) {
    // Nothing (or only part) was recorded: let GitHub see a failure so the delivery can be redelivered.
    deps.log("error", "delivery failed before it was recorded", { connector: live.id, error: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
    return json({ error: "unavailable" }, 503);
  }
  return json({ ok: true }, 200);
}

// ── production wiring ──────────────────────────────────────────────────────

const RATE_WINDOW_SECONDS = 60;

async function rateCheck(key: string, max: number): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const { data, error } = await createAdminClient().rpc("nopm_rate_check", {
    p_key: key,
    p_max: max,
    p_window_seconds: RATE_WINDOW_SECONDS,
  });
  if (error) {
    console.error("[nopm][github] nopm_rate_check RPC failed - FAILING CLOSED", { key, error: error.message });
    return { allowed: false, retryAfterSeconds: 30 };
  }
  const result = data as { allowed: boolean; retry_after_seconds: number };
  return { allowed: result.allowed, retryAfterSeconds: result.retry_after_seconds };
}

export function productionGithubDeps(): GithubWebhookDeps {
  return {
    db: createAdminClient(),
    loadConnector: getGithubConnectorById,
    readSecret: (c) => decryptWebhookSecret(c.secret_enc),
    rateCheck,
    ipKey: (headers) => ipRateKey(headers),
    log: (level, message, meta = {}) => {
      const line = `[nopm][github] ${message}`;
      if (level === "error") console.error(line, meta);
      else if (level === "warn") console.warn(line, meta);
      else console.info(line, meta);
    },
  };
}
