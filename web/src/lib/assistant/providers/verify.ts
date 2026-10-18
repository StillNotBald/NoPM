/**
 * Save-time check of a BYOK assistant key (Q-ACC-12, 2026-10-17).
 *
 * Two rules, both before anything is stored:
 *  1. The provider must be one NoPM knows (`isKnownProvider`); anything else is
 *     refused instead of being saved and failing at the first chat turn.
 *  2. The key is TESTED against the provider with a free, read-only call (list
 *     models / key info). No tokens are spent and the key is never logged or
 *     echoed: results are a verdict only.
 *
 * Verdicts: "valid"; "invalid" (the provider rejected the key: 401/403);
 * "unreachable" (network error, timeout or a 5xx/429 from the provider, so
 * nothing can be concluded about the key).
 */

import type { Provider } from "./index";

export const KNOWN_PROVIDERS: readonly Provider[] = ["openai", "anthropic", "google", "openrouter"];

export function isKnownProvider(value: unknown): value is Provider {
  return typeof value === "string" && (KNOWN_PROVIDERS as readonly string[]).includes(value);
}

export type KeyVerdict = "valid" | "invalid" | "unreachable";

const TIMEOUT_MS = 8_000;

function request(provider: Provider, apiKey: string): { url: string; init: RequestInit } {
  switch (provider) {
    case "openai":
      return { url: "https://api.openai.com/v1/models", init: { headers: { Authorization: `Bearer ${apiKey}` } } };
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/models",
        init: { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } },
      };
    case "google":
      // The key rides in a header, never in a URL that could end up in a log.
      return {
        url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
        init: { headers: { "x-goog-api-key": apiKey } },
      };
    case "openrouter":
      return { url: "https://openrouter.ai/api/v1/auth/key", init: { headers: { Authorization: `Bearer ${apiKey}` } } };
  }
}

export async function verifyProviderKey(provider: Provider, apiKey: string): Promise<KeyVerdict> {
  const { url, init } = request(provider, apiKey);
  try {
    const res = await fetch(url, { ...init, method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) return "valid";
    // Google answers a bad key with 400 API_KEY_INVALID as well as 401/403.
    if (res.status === 401 || res.status === 403 || (provider === "google" && res.status === 400)) return "invalid";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}
