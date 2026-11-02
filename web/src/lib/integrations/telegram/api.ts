/**
 * The REST caller behind `TelegramDeps.api`: mint a per-action token, make ONE
 * call to the documented route, revoke the token (always, in `finally`).
 * Never throws: a failure is a status the handler turns into a plain sentence.
 *
 * Mint, revoke and fetch are injectable so the order of events is unit-tested
 * without a database.
 */

import { randomUUID } from "node:crypto";
import type { ApiRequest, ApiResult } from "./handlers";
import { isReadOnlyScopes, mintActionToken, revokeActionToken, type ActionToken } from "./token";
import type { ConnectorRow } from "@/lib/integrations/types";
import type { LinkedProfile } from "@/lib/integrations/identity";

/**
 * The ONLY base URL the per-action bearer may be sent to: the configured app URL (NEXT_PUBLIC_APP_URL, or the
 * platform's production host). A request-derived origin is never trusted, except a loopback host for local
 * development. Null when nothing trustworthy is configured: the caller then refuses to mint or send anything.
 */
export function trustedApiBase(requestOrigin: string | null | undefined, env: Record<string, string | undefined> = process.env): string | null {
  const configured = env.NEXT_PUBLIC_APP_URL?.trim();
  const vercelHost = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const base = configured || (vercelHost ? `https://${vercelHost}` : "");
  if (base) return base.replace(/\/+$/, "");
  try {
    const u = new URL(requestOrigin ?? "");
    if (["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return u.origin;
  } catch {
    // not a URL
  }
  return null;
}

export type ApiCallerDeps = {
  /** Must come from `trustedApiBase`. Null: every call fails with 503 before a token is minted. */
  origin: string | null;
  mint?: (connector: ConnectorRow, profile: LinkedProfile, scopes: string[], opts?: { ttlMs?: number }) => Promise<ActionToken>;
  revoke?: (connector: ConnectorRow, profile: LinkedProfile, id: string, opts?: { audit?: boolean }) => Promise<void>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function makeApiCaller(d: ApiCallerDeps): (req: ApiRequest) => Promise<ApiResult> {
  const mint = d.mint ?? mintActionToken;
  const revoke = d.revoke ?? revokeActionToken;
  const doFetch = d.fetchImpl ?? fetch;
  return async (req) => {
    if (!d.origin) return { status: 503, body: { error: "app_url_not_configured" } };
    let token: ActionToken;
    try {
      token = await mint(req.connector, req.profile, req.scopes);
    } catch {
      // A token that could not be minted (or audited) means the action does not happen.
      return { status: 401, body: { error: "token_unavailable" } };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), d.timeoutMs ?? 20_000);
    try {
      const res = await doFetch(`${d.origin.replace(/\/+$/, "")}${req.path}`, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${token.raw}`,
          "Content-Type": "application/json",
          "X-Request-Id": randomUUID(),
        },
        ...(req.body !== undefined && req.method !== "GET" ? { body: JSON.stringify(req.body) } : {}),
        // A redirect could carry the bearer to another host: refuse to follow one.
        redirect: "error",
        signal: controller.signal,
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    } catch {
      return { status: 503, body: { error: "unreachable" } };
    } finally {
      clearTimeout(timer);
      await revoke(req.connector, req.profile, token.id, { audit: !isReadOnlyScopes(req.scopes) });
    }
  };
}
