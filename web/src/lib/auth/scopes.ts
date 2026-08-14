/**
 * Central scope registry. Every `resource:action` scope the API enforces via
 * requireScope() is listed here, so a Personal Access Token can only be minted
 * with scopes the system actually understands — a bogus scope is rejected at
 * creation rather than silently granted (and never matched).
 *
 * hasScope() (auth/tokens.ts) still honours legacy wildcards ("<resource>:*" and
 * the global "*") for already-minted tokens, but isValidScope() — used at MINT
 * time — accepts only concrete scopes and per-resource "<resource>:*" wildcards.
 * The bare global "*" can no longer be minted (defense-in-depth).
 */
export const SCOPES = [
  "project:read", "project:write",
  "program:read", "program:write",
  "milestone:read", "milestone:write",
  "task:read", "task:write", "task:delete:request", "task:delete:approve",
  "project:delete:request", "project:delete:approve",
  "risk:read", "risk:write",
  "issue:read", "issue:write",
  "clash:read", "clash:write",
  "resource:read", "resource:write",
  "time:read", "time:write",
  "budget:read", "budget:write",
  "document:read", "document:write",
  "change:read", "change:write",
  "rebaseline:approve",
  "decision:read", "decision:write",
  "notification:read",
  "audit:read",
  "assistant:read", "assistant:write",
  "saved_view:read", "saved_view:write",
] as const;

export type Scope = (typeof SCOPES)[number];

/** Resource prefixes that support a `<resource>:*` wildcard grant. */
export const SCOPE_RESOURCES: ReadonlySet<string> = new Set(
  SCOPES.map((s) => s.split(":")[0]),
);

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);

// [a-z_]+ (not just [a-z]+) so an underscored resource name — e.g.
// saved_view — still supports a "<resource>:*" wildcard grant.
const WILDCARD = /^([a-z_]+):\*$/;

/**
 * True if `scope` is a known concrete scope, a `<resource>:*` wildcard for a
 * known resource, or the global `*`. Used to validate PAT scopes at mint time.
 */
export function isValidScope(scope: string): boolean {
  if (SCOPE_SET.has(scope)) return true;
  const m = scope.match(WILDCARD);
  return !!m && SCOPE_RESOURCES.has(m[1]);
}

/**
 * Least-privilege preset for the "Connect your agent" onboarding flow
 * (F1e / L-49) — every read scope in the registry plus `task:write`, so a
 * freshly-minted agent PAT can read the whole workspace and move/edit tasks
 * but can never request/approve a deletion, approve a rebaseline, or write
 * anything else. Derived from SCOPES (not hand-listed) so it can never drift
 * onto a scope the registry doesn't recognise; scopes.test.ts asserts the
 * least-privilege shape directly against this constant.
 */
export const AGENT_PRESET_SCOPES: readonly Scope[] = SCOPES.filter((s) =>
  s.endsWith(":read"),
).concat(["task:write"]);
