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
import { mintActionToken, revokeActionToken, type ActionToken } from "./token";
import type { ConnectorRow } from "@/lib/integrations/types";
import type { LinkedProfile } from "@/lib/integrations/identity";

export type ApiCallerDeps = {
  origin: string;
  mint?: (connector: ConnectorRow, profile: LinkedProfile, scopes: string[]) => Promise<ActionToken>;
  revoke?: (connector: ConnectorRow, profile: LinkedProfile, id: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function makeApiCaller(d: ApiCallerDeps): (req: ApiRequest) => Promise<ApiResult> {
  const mint = d.mint ?? mintActionToken;
  const revoke = d.revoke ?? revokeActionToken;
  const doFetch = d.fetchImpl ?? fetch;
  return async (req) => {
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
      await revoke(req.connector, req.profile, token.id);
    }
  };
}
