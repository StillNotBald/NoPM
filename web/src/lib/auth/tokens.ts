import { createHash, randomBytes } from "node:crypto";

/**
 * Scoped Personal Access Tokens (PATs). The raw token is shown ONCE at
 * creation; only its SHA-256 hash is stored. Scopes are `resource:action`
 * strings (e.g. "task:read", "task:write", "task:delete:request").
 */
export const TOKEN_PREFIX = process.env.NOPM_TOKEN_PREFIX || "npm_";

/**
 * `prefixOverride` lets a distinct token family (e.g. invites' `npi_`, D13
 * f2b-specs.md) reuse this exact generation/hash logic instead of forking
 * it — the raw-token shape and SHA-256-at-rest guarantee stay identical
 * across every token family this API mints. Defaults to TOKEN_PREFIX (the
 * existing `npm_` PAT behavior, unchanged for every existing caller).
 */
export function generateToken(prefixOverride?: string): { raw: string; hash: string; prefix: string } {
  const prefix = prefixOverride ?? TOKEN_PREFIX;
  const secret = randomBytes(24).toString("base64url"); // 32 url-safe chars
  const raw = `${prefix}${secret}`;
  return { raw, hash: hashToken(raw), prefix };
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** A token grants `required` if it holds it exactly, holds `resource:*`, or `*`. */
export function hasScope(granted: string[], required: string): boolean {
  if (granted.includes("*") || granted.includes(required)) return true;
  const resource = required.split(":")[0];
  return granted.includes(`${resource}:*`);
}
