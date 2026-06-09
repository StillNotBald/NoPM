/**
 * Central scope registry. Every `resource:action` scope the API enforces via
 * requireScope() is listed here, so a Personal Access Token can only be minted
 * with scopes the system actually understands — a bogus scope is rejected at
 * creation rather than silently granted (and never matched).
 *
 * hasScope() (auth/tokens.ts) also honours wildcards: "<resource>:*" and "*".
 * isValidScope() accepts those wildcard forms for known resources too.
 */
export const SCOPES = [
  "project:read", "project:write",
  "milestone:read", "milestone:write",
  "task:read", "task:write", "task:delete:request", "task:delete:approve",
  "risk:read", "risk:write",
  "issue:read", "issue:write",
  "clash:read", "clash:write",
  "resource:read", "resource:write",
  "time:read", "time:write",
  "budget:read", "budget:write",
  "document:read", "document:write",
  "change:read", "change:write",
  "decision:read", "decision:write",
  "notification:read",
  "audit:read",
  "assistant:read", "assistant:write",
] as const;

export type Scope = (typeof SCOPES)[number];

/** Resource prefixes that support a `<resource>:*` wildcard grant. */
export const SCOPE_RESOURCES: ReadonlySet<string> = new Set(
  SCOPES.map((s) => s.split(":")[0]),
);

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);

const WILDCARD = /^([a-z]+):\*$/;

/**
 * True if `scope` is a known concrete scope, a `<resource>:*` wildcard for a
 * known resource, or the global `*`. Used to validate PAT scopes at mint time.
 */
export function isValidScope(scope: string): boolean {
  if (scope === "*") return true;
  if (SCOPE_SET.has(scope)) return true;
  const m = scope.match(WILDCARD);
  return !!m && SCOPE_RESOURCES.has(m[1]);
}
