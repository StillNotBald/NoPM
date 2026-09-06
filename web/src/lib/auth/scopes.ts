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
  "sprint:read", "sprint:write",
  "risk:read", "risk:write",
  "issue:read", "issue:write",
  "clash:read", "clash:write",
  "resource:read", "resource:write",
  "time:read", "time:write", "time:submit", "time:approve",
  "budget:read", "budget:write",
  "document:read", "document:write",
  "change:read", "change:write", "change:decide",
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

/**
 * Full scope choice list for the manual token-mint UI (tokens/page.tsx),
 * DERIVED from SCOPES — replaces a hand-curated list that silently drifted
 * out of sync as new resources (change/document/saved_view/assistant/
 * decision/program/sprint/milestone/notification, rebaseline:approve) were
 * added to the registry without a matching checkbox ever appearing.
 *
 * Grouped by resource, in registry order. A resource with MORE than one
 * concrete scope gets a `<resource>:*` wildcard choice first, followed by
 * every concrete scope for that resource; a resource with exactly one scope
 * (e.g. `notification:read`, `audit:read`, `rebaseline:approve`) gets no
 * wildcard — one scope already IS the whole resource, so a wildcard would
 * just be a second name for the same grant. `task:delete:request`/`approve`
 * and `project:delete:request`/`approve` fall out of this naturally as
 * explicit entries (they're concrete scopes on the `task`/`project`
 * resources, always listed alongside that resource's wildcard).
 *
 * scopes.test.ts asserts this covers every SCOPES entry either directly or
 * via its resource wildcard, so a future scope addition can never silently
 * fail to show up in the mint UI again.
 */
export function scopeChoices(): string[] {
  const byResource = new Map<string, Scope[]>();
  for (const scope of SCOPES) {
    const resource = scope.split(":")[0];
    const list = byResource.get(resource);
    if (list) list.push(scope);
    else byResource.set(resource, [scope]);
  }
  const choices: string[] = [];
  for (const scopesForResource of byResource.values()) {
    if (scopesForResource.length > 1) choices.push(`${scopesForResource[0].split(":")[0]}:*`);
    choices.push(...scopesForResource);
  }
  return choices;
}
